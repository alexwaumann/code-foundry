package command_test

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// pr.ready, pr.draft and pr.auto-merge: the request each sends, the confirmation
// auto-merge asks before it turns on, and the daemon's refusals passed through.
func TestPullRequestStateCommands(t *testing.T) {
	args := func(kv ...string) map[string]string {
		m := map[string]string{"repo-slug": "o/r", "number": "142"}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return m
	}
	const head = "e2e0142e2e0142e2e0142e2e0142e2e0142e2e01"
	tests := []struct {
		name      string
		cmd       string
		args      map[string]string
		confirmed bool
		backend   func(*commandtest.Gh)
		wantReq   proto.Message
		wantMsg   string
		wantAsk   string
		wantErr   error
		wantCode  connect.Code
	}{
		{name: "ready", cmd: "pr.ready", args: args(),
			wantReq: &v1.SetPullRequestDraftRequest{RepoSlug: "o/r", Number: 142}, wantMsg: "Marked #142 ready for review"},
		{name: "to a draft", cmd: "pr.draft", args: args(),
			wantReq: &v1.SetPullRequestDraftRequest{RepoSlug: "o/r", Number: 142, Draft: true}, wantMsg: "Converted #142 to a draft"},
		{name: "already ready passes through", cmd: "pr.ready", args: args(),
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodeFailedPrecondition, errors.New("pull request #142 is already ready for review"))
			},
			wantReq: &v1.SetPullRequestDraftRequest{RepoSlug: "o/r", Number: 142}, wantCode: connect.CodeFailedPrecondition},
		{name: "no permission passes through", cmd: "pr.draft", args: args(),
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodePermissionDenied, errors.New("Resource not accessible by integration"))
			},
			wantReq: &v1.SetPullRequestDraftRequest{RepoSlug: "o/r", Number: 142, Draft: true}, wantCode: connect.CodePermissionDenied},
		{name: "bad number", cmd: "pr.ready", args: map[string]string{"repo-slug": "o/r", "number": "0"}, wantErr: command.ErrInvalidArgs},
		{name: "auto-merge on asks first", cmd: "pr.auto-merge", args: args("method", "squash"),
			wantAsk: "Turn on auto-merge for #142 in o/r? GitHub merges it with squash once its required checks and reviews pass."},
		{name: "auto-merge on, confirmed, with the shown head", cmd: "pr.auto-merge", args: args("method", "merge", "head-sha", head), confirmed: true,
			wantReq: &v1.SetPullRequestAutoMergeRequest{RepoSlug: "o/r", Number: 142, Enabled: true,
				Method: v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_MERGE, ExpectedHeadSha: head},
			wantMsg: "Auto-merge on for #142"},
		{name: "auto-merge off does not ask", cmd: "pr.auto-merge", args: args("off", "true"),
			wantReq: &v1.SetPullRequestAutoMergeRequest{RepoSlug: "o/r", Number: 142}, wantMsg: "Auto-merge off for #142"},
		{name: "auto-merge needs a method or --off, without asking", cmd: "pr.auto-merge", args: args(), wantErr: command.ErrInvalidArgs},
		{name: "--off takes no method", cmd: "pr.auto-merge", args: args("off", "true", "method", "squash"), wantErr: command.ErrInvalidArgs},
		{name: "unknown method", cmd: "pr.auto-merge", args: args("method", "octopus"), confirmed: true, wantErr: command.ErrInvalidArgs},
		{name: "GitHub's clean status passes through", cmd: "pr.auto-merge", args: args("method", "rebase"), confirmed: true,
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodeFailedPrecondition, errors.New("pull request #142 can be merged now; merge it instead"))
			},
			wantReq:  &v1.SetPullRequestAutoMergeRequest{RepoSlug: "o/r", Number: 142, Enabled: true, Method: v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_REBASE},
			wantCode: connect.CodeFailedPrecondition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, be := newPullRequestRegistry(t)
			if tt.backend != nil {
				tt.backend(be)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, tt.cmd, tt.args, command.Confirmed(tt.confirmed))
			reqs := be.Requests()
			if tt.wantReq == nil {
				if len(reqs) != 0 {
					t.Errorf("requests = %v, want none", reqs)
				}
			} else if len(reqs) != 1 || !proto.Equal(reqs[0], tt.wantReq) {
				t.Errorf("requests = %v, want %v", reqs, tt.wantReq)
			}
			var ce *command.ConfirmError
			switch {
			case tt.wantAsk != "":
				if !errors.As(err, &ce) || ce.Message != tt.wantAsk {
					t.Errorf("err = %v, want the confirmation %q", err, tt.wantAsk)
				}
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
