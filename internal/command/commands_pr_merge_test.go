package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

const (
	methodMerge  = v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_MERGE
	methodSquash = v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_SQUASH
	methodRebase = v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_REBASE
)

func TestPullRequestMerge(t *testing.T) {
	args := func(kv ...string) map[string]string {
		m := map[string]string{"repo-slug": "o/r", "number": "142"}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return m
	}
	tests := []struct {
		name      string
		args      map[string]string
		confirmed bool
		backend   func(*commandtest.Gh)
		wantReq   proto.Message
		wantMsg   string
		wantErr   error
		wantCode  connect.Code
	}{
		{name: "needs confirmation", args: args("method", "squash"),
			wantReq: &v1.GetPullRequestDetailRequest{RepoSlug: "o/r", Number: 142}, wantErr: command.ErrNeedsConfirmation},
		{name: "squash, delete the branch", args: args("method", "squash", "delete-branch", "true"), confirmed: true,
			wantReq: &v1.MergePullRequestRequest{RepoSlug: "o/r", Number: 142, Method: methodSquash, DeleteBranch: true},
			wantMsg: "Merged #142 (5e1f00d); deleted branch b"},
		{name: "merge commit", args: args("method", "merge"), confirmed: true,
			wantReq: &v1.MergePullRequestRequest{RepoSlug: "o/r", Number: 142, Method: methodMerge}, wantMsg: "Merged #142 (5e1f00d)"},
		{name: "rebase", args: args("method", "rebase", "delete-branch", "false"), confirmed: true,
			wantReq: &v1.MergePullRequestRequest{RepoSlug: "o/r", Number: 142, Method: methodRebase}, wantMsg: "Merged #142 (5e1f00d)"},
		{name: "no message from the daemon: built from the sha", args: args("method", "squash"), confirmed: true,
			backend: func(g *commandtest.Gh) { g.Merge = &v1.MergePullRequestResponse{Merged: true, Sha: "abcdef0123"} },
			wantReq: &v1.MergePullRequestRequest{RepoSlug: "o/r", Number: 142, Method: methodSquash}, wantMsg: "Merged #142 (abcdef0)"},
		{name: "method is required", args: args(), confirmed: true, wantErr: command.ErrInvalidArgs},
		{name: "unknown method", args: args("method", "octopus"), confirmed: true, wantErr: command.ErrInvalidArgs},
		{name: "bad number", args: map[string]string{"repo-slug": "o/r", "number": "0", "method": "squash"}, confirmed: true,
			wantErr: command.ErrInvalidArgs},
		{name: "head moved passes through", args: args("method", "squash"), confirmed: true,
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodeFailedPrecondition, errors.New("pull request #142 changed on GitHub since it was loaded"))
			},
			wantReq: &v1.MergePullRequestRequest{RepoSlug: "o/r", Number: 142, Method: methodSquash}, wantCode: connect.CodeFailedPrecondition},
		{name: "no write access passes through", args: args("method", "squash"), confirmed: true,
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodePermissionDenied, errors.New("Resource not accessible by integration"))
			},
			wantReq: &v1.MergePullRequestRequest{RepoSlug: "o/r", Number: 142, Method: methodSquash}, wantCode: connect.CodePermissionDenied},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, be := newPullRequestRegistry(t)
			if tt.backend != nil {
				tt.backend(be)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, "pr.merge", tt.args, command.Confirmed(tt.confirmed))
			reqs := be.Requests()
			if tt.wantReq == nil {
				if len(reqs) != 0 {
					t.Errorf("requests = %v, want none", reqs)
				}
			} else if len(reqs) != 1 || !proto.Equal(reqs[0], tt.wantReq) {
				t.Errorf("requests = %v, want %v", reqs, tt.wantReq)
			}
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Errorf("err = %v, want %v", err, tt.wantErr)
				}
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Errorf("err = %v, want code %v", err, tt.wantCode)
				}
			case err != nil:
				t.Fatal(err)
			case res.Message != tt.wantMsg:
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
		})
	}
}

func TestPullRequestMergeConfirmMessage(t *testing.T) {
	pr := func(base, head string, fork bool) *v1.PullRequestDetail {
		return &v1.PullRequestDetail{PullRequest: &v1.PullRequest{Number: 142, BaseRef: base, HeadRef: head, IsCrossRepository: fork}}
	}
	tests := []struct {
		name   string
		detail *v1.PullRequestDetail
		err    error
		args   map[string]string
		want   string
	}{
		{name: "squash", detail: pr("main", "feat/sidebar", false), args: map[string]string{"method": "squash"},
			want: "Merge #142 into main with squash?"},
		{name: "merge commit, deleting the branch", detail: pr("main", "feat/sidebar", false), args: map[string]string{"method": "merge", "delete-branch": "true"},
			want: "Merge #142 into main with a merge commit? Branch feat/sidebar is deleted afterwards."},
		{name: "a fork's branch is not mentioned", detail: pr("develop", "patch-1", true), args: map[string]string{"method": "rebase", "delete-branch": "true"},
			want: "Merge #142 into develop with rebase?"},
		{name: "detail unreadable: the static message", err: connect.NewError(connect.CodeUnavailable, errors.New("offline")),
			args: map[string]string{"method": "squash"}, want: "Merge #142 with squash?"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, be := newPullRequestRegistry(t)
			be.Detail, be.Err = tt.detail, tt.err
			args := map[string]string{"repo-slug": "o/r", "number": "142"}
			for k, v := range tt.args {
				args[k] = v
			}
			_, err := reg.Invoke(context.Background(), command.Context{}, "pr.merge", args)
			var ce *command.ConfirmError
			if !errors.As(err, &ce) {
				t.Fatalf("err = %v, want a ConfirmError", err)
			}
			if ce.Message != tt.want || ce.Title != "Merge Pull Request" {
				t.Errorf("confirm = %q (%q), want %q", ce.Message, ce.Title, tt.want)
			}
			if len(be.Requests()) != 1 {
				t.Errorf("requests = %v, want the detail read only", be.Requests())
			}
		})
	}
}

func TestPullRequestMergeJSONAndAvailability(t *testing.T) {
	reg, _ := newPullRequestRegistry(t)
	c, ok := reg.Get("pr.merge")
	if !ok || c.Confirm == "" || !c.Available(command.Context{}) {
		t.Fatalf("pr.merge: registered %t, confirm %q", ok, c.Confirm)
	}
	res, err := reg.Invoke(context.Background(), command.Context{}, "pr.merge",
		map[string]string{"repo-slug": "o/r", "number": "142", "method": "squash", "delete-branch": "true"}, command.Confirmed(true))
	if err != nil {
		t.Fatal(err)
	}
	if js, _ := res.EncodeJSON(); !strings.Contains(js, `"merged":true`) || !strings.Contains(js, `"branchDeleted":true`) {
		t.Errorf("json = %s", js)
	}
}
