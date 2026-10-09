package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gitops"
	"github.com/alexwaumann/code-foundry/internal/store/gitops/gitopstest"
)

func newGitOpsFixture(t *testing.T) (*gitopstest.Fake, codefoundryv1connect.GitOpsServiceClient, chan struct{}) {
	t.Helper()
	b := bus.New()
	fake := gitopstest.New(b)
	done := make(chan struct{})
	route := NewGitOps(fake, b, done).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return fake, codefoundryv1connect.NewGitOpsServiceClient(srv.Client(), srv.URL), done
}

type gitOpResponse interface{ GetOp() *v1.GitOp }

func TestGitOpsRPCs(t *testing.T) {
	fake, c, _ := newGitOpsFixture(t)
	fake.URL = "https://github.com/o/r/pull/1"
	ctx := context.Background()
	call := func(r gitOpResponse, err error) *v1.GitOp {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return r.GetOp()
	}
	unwrap := func(r any, err error) (gitOpResponse, error) {
		if err != nil {
			return nil, err
		}
		// connect.Response[T].Msg implements gitOpResponse.
		return r.(interface{ Any() any }).Any().(gitOpResponse), nil
	}
	tests := []struct {
		name string
		run  func() (gitOpResponse, error)
		call string
		kind v1.GitOpKind
	}{
		{"fetch", func() (gitOpResponse, error) {
			return unwrap(c.Fetch(ctx, connect.NewRequest(&v1.GitFetchRequest{WorktreePath: "/w"})))
		}, "Fetch /w", v1.GitOpKind_GIT_OP_KIND_FETCH},
		{"fetch a remote branch", func() (gitOpResponse, error) {
			return unwrap(c.Fetch(ctx, connect.NewRequest(&v1.GitFetchRequest{WorktreePath: "/w", Remote: "origin", Branch: "feat/x"})))
		}, `Fetch /w remote="origin" branch="feat/x"`, v1.GitOpKind_GIT_OP_KIND_FETCH},
		{"pull rebase", func() (gitOpResponse, error) {
			return unwrap(c.Pull(ctx, connect.NewRequest(&v1.GitPullRequest{WorktreePath: "/w", Rebase: true})))
		}, "Pull /w rebase=true", v1.GitOpKind_GIT_OP_KIND_PULL},
		{"push force", func() (gitOpResponse, error) {
			return unwrap(c.Push(ctx, connect.NewRequest(&v1.GitPushRequest{WorktreePath: "/w", ForceWithLease: true})))
		}, "Push /w force=true", v1.GitOpKind_GIT_OP_KIND_PUSH},
		{"create pr", func() (gitOpResponse, error) {
			return unwrap(c.CreatePullRequest(ctx, connect.NewRequest(&v1.CreatePullRequestRequest{WorktreePath: "/w", Title: "T", Body: "B", Draft: true, Base: "dev"})))
		}, `CreatePR /w title="T" body="B" draft=true base="dev"`, v1.GitOpKind_GIT_OP_KIND_PR_CREATE},
		{"open pr", func() (gitOpResponse, error) {
			return unwrap(c.OpenPullRequest(ctx, connect.NewRequest(&v1.OpenPullRequestRequest{WorktreePath: "/w"})))
		}, "OpenPR /w", v1.GitOpKind_GIT_OP_KIND_PR_OPEN},
		{"open editor", func() (gitOpResponse, error) {
			return unwrap(c.OpenEditor(ctx, connect.NewRequest(&v1.OpenEditorRequest{WorktreePath: "/w"})))
		}, "OpenEditor /w", v1.GitOpKind_GIT_OP_KIND_OPEN_EDITOR},
		{"reveal", func() (gitOpResponse, error) {
			return unwrap(c.Reveal(ctx, connect.NewRequest(&v1.RevealRequest{WorktreePath: "/w"})))
		}, "Reveal /w", v1.GitOpKind_GIT_OP_KIND_REVEAL},
		{"open url", func() (gitOpResponse, error) {
			return unwrap(c.OpenUrl(ctx, connect.NewRequest(&v1.OpenUrlRequest{Url: "https://x.test"})))
		}, "OpenURL https://x.test", v1.GitOpKind_GIT_OP_KIND_OPEN_URL},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			op := call(tt.run())
			if op.GetKind() != tt.kind || op.GetState() != v1.GitOpState_GIT_OP_STATE_SUCCEEDED || op.GetUrl() != fake.URL || op.GetDurationMs() != 1000 || op.GetFinishedAt() == nil {
				t.Errorf("op = %v", op)
			}
			if last := fake.Calls[len(fake.Calls)-1]; last != tt.call {
				t.Errorf("store call = %q, want %q", last, tt.call)
			}
		})
	}

	list, err := c.List(ctx, connect.NewRequest(&v1.ListGitOpsRequest{}))
	if err != nil || len(list.Msg.GetOps()) != len(tests) {
		t.Fatalf("List = %v, %v", list, err)
	}

	// A failed op is a response, not an RPC error.
	fake.Fail = "rejected"
	op := call(unwrap(c.Push(ctx, connect.NewRequest(&v1.GitPushRequest{WorktreePath: "/w"}))))
	if op.GetState() != v1.GitOpState_GIT_OP_STATE_FAILED || op.GetSummary() != "rejected" {
		t.Errorf("failed op = %v", op)
	}
}

func TestGitOpsErrors(t *testing.T) {
	tests := []struct {
		err  error
		code connect.Code
	}{
		{fmt.Errorf("%w: bad path", gitops.ErrInvalidArgument), connect.CodeInvalidArgument},
		{gitops.ErrClosed, connect.CodeUnavailable},
		{fmt.Errorf("momentum: %w", gitops.ErrNoRemote), connect.CodeFailedPrecondition},
		{context.Canceled, connect.CodeCanceled},
		{errors.New("boom"), connect.CodeInternal},
	}
	for _, tt := range tests {
		fake, c, _ := newGitOpsFixture(t)
		fake.Err = tt.err
		_, err := c.Fetch(context.Background(), connect.NewRequest(&v1.GitFetchRequest{WorktreePath: "/w"}))
		if connect.CodeOf(err) != tt.code {
			t.Errorf("%v: code = %v, want %v", tt.err, connect.CodeOf(err), tt.code)
		}
	}
}

func TestGitOpsWatch(t *testing.T) {
	fake, c, done := newGitOpsFixture(t)
	fake.Put(gitops.Op{ID: "op-old", Kind: gitops.KindFetch, State: gitops.StateSucceeded})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := c.Watch(ctx, connect.NewRequest(&v1.WatchGitOpsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	recv := func() *v1.GitOpsEvent {
		t.Helper()
		if !s.Receive() {
			t.Fatalf("stream ended: %v", s.Err())
		}
		return s.Msg()
	}
	if snap := recv().GetSnapshot(); len(snap.GetOps()) != 1 || snap.GetOps()[0].GetId() != "op-old" {
		t.Fatalf("first event = %v, want the snapshot", snap)
	}
	fake.Publish(gitops.Event{Type: gitops.Queued, Op: gitops.Op{ID: "op-q", Kind: gitops.KindPull}})
	if q := recv().GetQueued(); q.GetId() != "op-q" || q.GetKind() != v1.GitOpKind_GIT_OP_KIND_PULL {
		t.Fatalf("queued = %v", q)
	}
	if _, err := fake.Reveal(ctx, "/w"); err != nil {
		t.Fatal(err)
	}
	if recv().GetStarted() == nil || recv().GetFinished().GetSummary() != "reveal ok" {
		t.Fatal("want started then finished")
	}
	close(done)
	if s.Receive() {
		t.Fatalf("stream should end after done, got %v", s.Msg())
	}
}

// gitops.Kind and gitops.State are converted to the proto enums by value.
func TestGitOpEnumsMatchProto(t *testing.T) {
	kinds := map[gitops.Kind]string{
		gitops.KindFetch: "FETCH", gitops.KindPull: "PULL", gitops.KindPush: "PUSH", gitops.KindPRCreate: "PR_CREATE",
		gitops.KindPROpen: "PR_OPEN", gitops.KindOpenEditor: "OPEN_EDITOR", gitops.KindReveal: "REVEAL", gitops.KindOpenURL: "OPEN_URL",
	}
	if len(kinds) != len(v1.GitOpKind_name)-1 {
		t.Errorf("proto has %d kinds, test covers %d", len(v1.GitOpKind_name)-1, len(kinds))
	}
	for k, name := range kinds {
		if got := v1.GitOpKind(k).String(); got != "GIT_OP_KIND_"+name {
			t.Errorf("kind %d (%s) = %s", k, k, got)
		}
	}
	states := map[gitops.State]string{gitops.StateQueued: "QUEUED", gitops.StateRunning: "RUNNING", gitops.StateSucceeded: "SUCCEEDED", gitops.StateFailed: "FAILED"}
	for st, name := range states {
		if got := v1.GitOpState(st).String(); !strings.HasSuffix(got, "_"+name) {
			t.Errorf("state %d = %s, want *_%s", st, got, name)
		}
	}
}
