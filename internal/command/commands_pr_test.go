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

func newPullRequestRegistry(t *testing.T) (*command.Registry, *commandtest.Gh) {
	t.Helper()
	reg := command.NewRegistry()
	be := &commandtest.Gh{}
	if err := command.RegisterPullRequest(reg, be); err != nil {
		t.Fatal(err)
	}
	return reg, be
}

func TestPullRequestCommandsAvailability(t *testing.T) {
	reg, _ := newPullRequestRegistry(t)
	for _, name := range []string{"pr.revert", "pr.review.request", "pr.refresh"} {
		c, ok := reg.Get(name)
		if !ok {
			t.Fatalf("%s not registered", name)
		}
		// The pull request is named by args, so every context works (the CLI's is empty).
		for _, ctx := range []command.Context{{}, {ActiveView: "pullrequests"}, {ActiveWorktreePath: "/wt"}} {
			if !c.Available(ctx) {
				t.Errorf("%s unavailable in %+v", name, ctx)
			}
		}
	}
	if c, _ := reg.Get("pr.revert"); c.Confirm == "" {
		t.Error("pr.revert needs confirmation")
	}
	for _, name := range []string{"pr.review.request", "pr.refresh"} {
		if c, _ := reg.Get(name); c.Confirm != "" {
			t.Errorf("%s asks for confirmation", name)
		}
	}
}

func TestPullRequestCommands(t *testing.T) {
	tests := []struct {
		name      string
		cmd       string
		args      map[string]string
		confirmed bool
		backend   func(*commandtest.Gh)
		wantReq   proto.Message
		wantMsg   string
		wantErr   error
		wantCode  connect.Code
	}{
		{name: "revert needs confirmation", cmd: "pr.revert", args: map[string]string{"repo-slug": "o/r", "number": "7"},
			wantErr: command.ErrNeedsConfirmation},
		{name: "revert", cmd: "pr.revert", args: map[string]string{"repo-slug": "o/r", "number": "7"}, confirmed: true,
			wantReq: &v1.RevertPullRequestRequest{RepoSlug: "o/r", Number: 7},
			wantMsg: "Opened #99 to revert #7: https://github.com/o/r/pull/99"},
		{name: "revert refused", cmd: "pr.revert", args: map[string]string{"repo-slug": "o/r", "number": "7"}, confirmed: true,
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodeFailedPrecondition, errors.New("pull request #7 is open, not merged"))
			},
			wantReq: &v1.RevertPullRequestRequest{RepoSlug: "o/r", Number: 7}, wantCode: connect.CodeFailedPrecondition},
		{name: "revert without number", cmd: "pr.revert", args: map[string]string{"repo-slug": "o/r"}, confirmed: true,
			wantErr: command.ErrInvalidArgs},
		{name: "revert bad number", cmd: "pr.revert", args: map[string]string{"repo-slug": "o/r", "number": "0"}, confirmed: true,
			wantErr: command.ErrInvalidArgs},
		{name: "revert number not an int", cmd: "pr.revert", args: map[string]string{"repo-slug": "o/r", "number": "seven"}, confirmed: true,
			wantErr: command.ErrInvalidArgs},
		{name: "request a user (defaults)", cmd: "pr.review.request", args: map[string]string{"repo-slug": "o/r", "number": "7", "login": "kim"},
			wantReq: &v1.SetReviewRequestRequest{RepoSlug: "o/r", Number: 7, Login: "kim", Kind: v1.ReviewerKind_REVIEWER_KIND_USER, Requested: true},
			wantMsg: "Requested a review from kim on #7"},
		{name: "withdraw a team", cmd: "pr.review.request",
			args:    map[string]string{"repo-slug": "o/r", "number": "7", "login": "acme/core", "kind": "team", "requested": "false"},
			wantReq: &v1.SetReviewRequestRequest{RepoSlug: "o/r", Number: 7, Login: "acme/core", Kind: v1.ReviewerKind_REVIEWER_KIND_TEAM},
			wantMsg: "Withdrew the review request for acme/core on #7"},
		{name: "request: bad kind", cmd: "pr.review.request", args: map[string]string{"repo-slug": "o/r", "number": "7", "login": "kim", "kind": "robot"},
			wantErr: command.ErrInvalidArgs},
		{name: "request: blank login", cmd: "pr.review.request", args: map[string]string{"repo-slug": "o/r", "number": "7", "login": "  "},
			wantErr: command.ErrInvalidArgs},
		{name: "request: no push access", cmd: "pr.review.request", args: map[string]string{"repo-slug": "o/r", "number": "7", "login": "kim"},
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodePermissionDenied, errors.New("Must have push access"))
			},
			wantReq:  &v1.SetReviewRequestRequest{RepoSlug: "o/r", Number: 7, Login: "kim", Kind: v1.ReviewerKind_REVIEWER_KIND_USER, Requested: true},
			wantCode: connect.CodePermissionDenied},
		{name: "refresh", cmd: "pr.refresh", args: map[string]string{"repo-slug": "O/R", "number": "7"},
			wantReq: &v1.GetPullRequestDetailRequest{RepoSlug: "O/R", Number: 7, Refresh: true}, wantMsg: "Refreshed #7: t"},
		{name: "refresh served the cached copy: an error", cmd: "pr.refresh", args: map[string]string{"repo-slug": "o/r", "number": "7"},
			backend: func(g *commandtest.Gh) {
				g.Detail = &v1.PullRequestDetail{PullRequest: &v1.PullRequest{Number: 7}, LastError: "cannot reach github"}
			},
			wantReq:  &v1.GetPullRequestDetailRequest{RepoSlug: "o/r", Number: 7, Refresh: true},
			wantCode: connect.CodeUnavailable},
		{name: "refresh: not found passes through", cmd: "pr.refresh", args: map[string]string{"repo-slug": "o/r", "number": "8"},
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodeNotFound, errors.New("no such pull request"))
			},
			wantReq: &v1.GetPullRequestDetailRequest{RepoSlug: "o/r", Number: 8, Refresh: true}, wantCode: connect.CodeNotFound},
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

func TestPullRequestRevertConfirmMessage(t *testing.T) {
	reg, _ := newPullRequestRegistry(t)
	_, err := reg.Invoke(context.Background(), command.Context{}, "pr.revert", map[string]string{"repo-slug": "o/r", "number": "138"})
	var ce *command.ConfirmError
	if !errors.As(err, &ce) {
		t.Fatalf("err = %v, want a ConfirmError", err)
	}
	if want := "This opens a new pull request that reverses the changes merged by #138."; ce.Message != want || ce.Title != "Revert Pull Request" {
		t.Errorf("confirm = %q (%q), want %q", ce.Message, ce.Title, want)
	}
}

func TestPullRequestRevertJSON(t *testing.T) {
	reg, _ := newPullRequestRegistry(t)
	res, err := reg.Invoke(context.Background(), command.Context{}, "pr.revert", map[string]string{"repo-slug": "o/r", "number": "7"}, command.Confirmed(true))
	if err != nil {
		t.Fatal(err)
	}
	if js, _ := res.EncodeJSON(); !strings.Contains(js, `"url":"https://github.com/o/r/pull/99"`) || !strings.Contains(js, `"number":99`) {
		t.Errorf("json = %s", js)
	}
}
