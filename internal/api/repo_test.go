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
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/repo/repotest"
)

func newRepoServer(t *testing.T) (*repotest.Fake, codefoundryv1connect.RepoServiceClient) {
	t.Helper()
	b := bus.New()
	fake := repotest.New(b)
	route := NewRepo(fake, b).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return fake, codefoundryv1connect.NewRepoServiceClient(srv.Client(), srv.URL)
}

func TestRepoUnaryAndErrorCodes(t *testing.T) {
	fake, c := newRepoServer(t)
	ctx := context.Background()

	reg, err := c.Register(ctx, connect.NewRequest(&v1.RegisterRepoRequest{Path: "/code/proj"}))
	if err != nil {
		t.Fatal(err)
	}
	r := reg.Msg.GetRepo()
	if r.GetId() != repotest.ID("/code/proj") || r.GetName() != "proj" || r.GetRegisteredAt() == nil ||
		len(r.GetWorktrees()) != 1 || !r.GetWorktrees()[0].GetIsMain() {
		t.Fatalf("Register = %v", r)
	}

	wt, err := c.CreateWorktree(ctx, connect.NewRequest(&v1.CreateWorktreeRequest{RepoId: r.GetId(), Branch: "a/b"}))
	if err != nil || wt.Msg.GetWorktree().GetPath() != "/code/proj.worktrees/a-b" {
		t.Fatalf("CreateWorktree = %v, %v", wt, err)
	}
	fake.UpdateWorktree(repo.Worktree{
		RepoID: r.GetId(), Path: "/code/proj.worktrees/a-b", Branch: "a/b",
		Status: repo.Status{Ahead: 2, Untracked: 3, Dirty: true, BaseRef: "origin/main", BaseBehind: 4, RefreshedAt: time.Unix(5, 0)},
	})

	list, err := c.List(ctx, connect.NewRequest(&v1.ListReposRequest{}))
	if err != nil || len(list.Msg.GetRepos()) != 1 {
		t.Fatalf("List = %v, %v", list, err)
	}
	st := list.Msg.GetRepos()[0].GetWorktrees()[1].GetStatus()
	if st.GetAhead() != 2 || st.GetUntracked() != 3 || !st.GetDirty() || st.GetBaseRef() != "origin/main" ||
		st.GetBaseBehind() != 4 || st.GetRefreshedAt().AsTime().Unix() != 5 {
		t.Fatalf("status = %v", st)
	}

	if _, err := c.Refresh(ctx, connect.NewRequest(&v1.RefreshRepoRequest{})); err != nil {
		t.Fatal(err)
	}
	if _, err := c.RemoveWorktree(ctx, connect.NewRequest(&v1.RemoveWorktreeRequest{RepoId: r.GetId(), Path: "/code/proj.worktrees/a-b"})); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Unregister(ctx, connect.NewRequest(&v1.UnregisterRepoRequest{Id: r.GetId()})); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name string
		call func() error
		want connect.Code
	}{
		{"get missing", func() error {
			_, err := c.Get(ctx, connect.NewRequest(&v1.GetRepoRequest{Id: "x"}))
			return err
		}, connect.CodeNotFound},
		{"unregister missing", func() error {
			_, err := c.Unregister(ctx, connect.NewRequest(&v1.UnregisterRepoRequest{Id: "x"}))
			return err
		}, connect.CodeNotFound},
		{"register relative", func() error {
			_, err := c.Register(ctx, connect.NewRequest(&v1.RegisterRepoRequest{Path: "rel"}))
			return err
		}, connect.CodeInvalidArgument},
		{"store precondition", func() error {
			fake.Err = fmt.Errorf("%w: dirty", repo.ErrFailedPrecondition)
			defer func() { fake.Err = nil }()
			_, err := c.RemoveWorktree(ctx, connect.NewRequest(&v1.RemoveWorktreeRequest{RepoId: "x"}))
			return err
		}, connect.CodeFailedPrecondition},
		{"store internal", func() error {
			fake.Err = errors.New("boom")
			defer func() { fake.Err = nil }()
			_, err := c.Refresh(ctx, connect.NewRequest(&v1.RefreshRepoRequest{}))
			return err
		}, connect.CodeInternal},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := connect.CodeOf(tt.call()); got != tt.want {
				t.Fatalf("code = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestRepoWatch(t *testing.T) {
	fake, c := newRepoServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	existing, _ := fake.Register(ctx, "/code/existing")

	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchReposRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	next := func() *v1.RepoEvent {
		t.Helper()
		if !stream.Receive() {
			t.Fatalf("stream ended: %v", stream.Err())
		}
		return stream.Msg()
	}

	snap := next().GetSnapshot()
	if len(snap.GetRepos()) != 1 || snap.GetRepos()[0].GetId() != existing.ID {
		t.Fatalf("first event = %v, want snapshot with the existing repo", snap)
	}

	r, _ := fake.Register(ctx, "/code/new")
	if got := next().GetRepoUpdated(); got.GetId() != r.ID {
		t.Fatalf("want repo_updated %s, got %v", r.ID, got)
	}
	w, _ := fake.CreateWorktree(ctx, repo.CreateWorktreeOptions{RepoID: r.ID, Branch: "x"})
	if got := next().GetRepoUpdated(); len(got.GetWorktrees()) != 2 {
		t.Fatalf("want repo_updated with 2 worktrees, got %v", got)
	}
	w.Status.Modified = 1
	fake.UpdateWorktree(w)
	if got := next().GetWorktreeUpdated(); got.GetPath() != w.Path || got.GetStatus().GetModified() != 1 {
		t.Fatalf("want worktree_updated, got %v", got)
	}
	_ = fake.RemoveWorktree(ctx, repo.RemoveWorktreeOptions{RepoID: r.ID, Path: w.Path})
	if got := next().GetWorktreeRemoved(); got.GetPath() != w.Path || got.GetRepoId() != r.ID {
		t.Fatalf("want worktree_removed, got %v", got)
	}
	next() // repo_updated after removal
	_ = fake.Unregister(ctx, r.ID)
	if got := next().GetRepoRemovedId(); got != r.ID {
		t.Fatalf("want repo_removed_id, got %v", got)
	}
}

func TestRepoWatchResyncsAfterDrops(t *testing.T) {
	fake, c := newRepoServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchReposRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	if !stream.Receive() || stream.Msg().GetSnapshot() == nil {
		t.Fatal("no initial snapshot")
	}
	// Overflow the subscriber buffer while the client is not reading. The handler
	// drains events into HTTP/2 flow-control windows (4 MiB per stream for Go's
	// client) before it blocks, so publish more than that.
	big := strings.Repeat("x", 4096)
	for i := range 2000 {
		fake.Put(repo.Repo{ID: fmt.Sprint(i % 3), Name: fmt.Sprint(i), Path: big})
	}
	for {
		if !stream.Receive() {
			t.Fatalf("no resync snapshot after drops; stream ended: %v", stream.Err())
		}
		if s := stream.Msg().GetSnapshot(); s != nil && len(s.GetRepos()) == 3 {
			return
		}
	}
}
