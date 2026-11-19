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

// pr.close and pr.reopen: the request each sends, the confirmation pr.close asks (naming
// the pull request), and the daemon's refusals passed through.
func TestPullRequestCloseCommands(t *testing.T) {
	args := map[string]string{"repo-slug": "o/r", "number": "142"}
	closeReq := &v1.SetPullRequestClosedRequest{RepoSlug: "o/r", Number: 142, Closed: true}
	getReq := &v1.GetPullRequestDetailRequest{RepoSlug: "o/r", Number: 142}
	titled := func(title string) func(*commandtest.Gh) {
		return func(g *commandtest.Gh) {
			g.Detail = &v1.PullRequestDetail{PullRequest: &v1.PullRequest{Number: 142, Title: title}}
		}
	}
	tests := []struct {
		name      string
		cmd       string
		args      map[string]string
		confirmed bool
		backend   func(*commandtest.Gh)
		wantReqs  []proto.Message
		wantMsg   string
		wantAsk   string
		wantErr   error
		wantCode  connect.Code
	}{
		{name: "close asks first, naming the pull request", cmd: "pr.close", args: args, backend: titled("Fix the flaky test"),
			wantReqs: []proto.Message{getReq},
			wantAsk:  "Close #142 “Fix the flaky test” in o/r without merging it? It can be reopened later."},
		{name: "a long title is cut", cmd: "pr.close", args: args, backend: titled(strings.Repeat("x", 100)),
			wantReqs: []proto.Message{getReq},
			wantAsk:  "Close #142 “" + strings.Repeat("x", 79) + "…” in o/r without merging it? It can be reopened later."},
		{name: "no detail: the static question", cmd: "pr.close", args: args,
			backend:  func(g *commandtest.Gh) { g.Err = connect.NewError(connect.CodeUnavailable, errors.New("offline")) },
			wantReqs: []proto.Message{getReq},
			wantAsk:  "Close #142 in o/r without merging it?"},
		{name: "close, confirmed", cmd: "pr.close", args: args, confirmed: true,
			wantReqs: []proto.Message{closeReq}, wantMsg: "Closed #142"},
		{name: "reopen does not ask", cmd: "pr.reopen", args: args,
			wantReqs: []proto.Message{&v1.SetPullRequestClosedRequest{RepoSlug: "o/r", Number: 142}}, wantMsg: "Reopened #142"},
		{name: "not open passes through", cmd: "pr.close", args: args, confirmed: true,
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodeFailedPrecondition, errors.New("pull request #142 is merged, not open"))
			},
			wantReqs: []proto.Message{closeReq}, wantCode: connect.CodeFailedPrecondition},
		{name: "merged cannot be reopened passes through", cmd: "pr.reopen", args: args,
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodeFailedPrecondition, errors.New("pull request #142 is merged; a merged pull request cannot be reopened"))
			},
			wantReqs: []proto.Message{&v1.SetPullRequestClosedRequest{RepoSlug: "o/r", Number: 142}}, wantCode: connect.CodeFailedPrecondition},
		{name: "no permission passes through", cmd: "pr.close", args: args, confirmed: true,
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodePermissionDenied, errors.New("GitHub does not let you close pull request #142"))
			},
			wantReqs: []proto.Message{closeReq}, wantCode: connect.CodePermissionDenied},
		{name: "a bad number is refused without asking", cmd: "pr.close", args: map[string]string{"repo-slug": "o/r", "number": "0"}, wantErr: command.ErrInvalidArgs},
		{name: "a blank slug is refused", cmd: "pr.reopen", args: map[string]string{"repo-slug": " ", "number": "1"}, wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, be := newPullRequestRegistry(t)
			if tt.backend != nil {
				tt.backend(be)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, tt.cmd, tt.args, command.Confirmed(tt.confirmed))
			reqs := be.Requests()
			if len(reqs) != len(tt.wantReqs) {
				t.Errorf("requests = %v, want %v", reqs, tt.wantReqs)
			} else {
				for i := range reqs {
					if !proto.Equal(reqs[i], tt.wantReqs[i]) {
						t.Errorf("request %d = %v, want %v", i, reqs[i], tt.wantReqs[i])
					}
				}
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
