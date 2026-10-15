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

func TestReviewCommandsAvailability(t *testing.T) {
	reg, _ := newPullRequestRegistry(t)
	for _, name := range []string{"pr.review", "pr.comment"} {
		c, ok := reg.Get(name)
		if !ok {
			t.Fatalf("%s not registered", name)
		}
		if c.Category != "Pull Request" || c.Confirm != "" || c.DynamicConfirm != nil {
			t.Errorf("%s: category %q, confirm %q", name, c.Category, c.Confirm)
		}
		for _, ctx := range []command.Context{{}, {ActiveView: "pullrequests"}, {ActiveWorktreePath: "/wt"}} {
			if !c.Available(ctx) {
				t.Errorf("%s unavailable in %+v", name, ctx)
			}
		}
	}
	// The CLI takes the body as the word after the number: pr review o/r 7 "lgtm" --verdict approve.
	for name, want := range map[string]string{"pr.review": "repo-slug number body", "pr.comment": "repo-slug number body"} {
		c, _ := reg.Get(name)
		var pos []string
		for _, a := range c.Args {
			if a.Positional {
				pos = append(pos, a.Name)
			}
		}
		if got := strings.Join(pos, " "); got != want {
			t.Errorf("%s positionals = %q, want %q", name, got, want)
		}
	}
}

func TestReviewCommands(t *testing.T) {
	const (
		approve = v1.PullRequestReviewEvent_PULL_REQUEST_REVIEW_EVENT_APPROVE
		changes = v1.PullRequestReviewEvent_PULL_REQUEST_REVIEW_EVENT_REQUEST_CHANGES
		comment = v1.PullRequestReviewEvent_PULL_REQUEST_REVIEW_EVENT_COMMENT
	)
	tests := []struct {
		name     string
		cmd      string
		args     map[string]string
		backend  func(*commandtest.Gh)
		wantReq  proto.Message
		wantMsg  string
		wantErr  error
		wantArg  string // the arg an ErrInvalidArgs names
		wantCode connect.Code
	}{
		{name: "approve without a body", cmd: "pr.review", args: map[string]string{"repo-slug": "o/r", "number": "7", "verdict": "approve"},
			wantReq: &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 7, Event: approve}, wantMsg: "Approved #7"},
		{name: "approve with a body, sent as typed (the daemon trims)", cmd: "pr.review", args: map[string]string{"repo-slug": "o/r", "number": "7", "verdict": "approve", "body": " lgtm \n"},
			wantReq: &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 7, Event: approve, Body: " lgtm \n"}, wantMsg: "Approved #7"},
		{name: "request changes", cmd: "pr.review", args: map[string]string{"repo-slug": "o/r", "number": "7", "verdict": "request-changes", "body": "fix x"},
			wantReq: &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 7, Event: changes, Body: "fix x"}, wantMsg: "Requested changes on #7"},
		{name: "comment review", cmd: "pr.review", args: map[string]string{"repo-slug": "o/r", "number": "7", "verdict": "comment", "body": "a note"},
			wantReq: &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 7, Event: comment, Body: "a note"}, wantMsg: "Commented on #7 (review)"},
		{name: "request changes without a body: the daemon's invalid argument", cmd: "pr.review", args: map[string]string{"repo-slug": "o/r", "number": "7", "verdict": "request-changes", "body": " "},
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodeInvalidArgument, errors.New("invalid argument: a body is required"))
			},
			wantReq:  &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 7, Event: changes, Body: " "},
			wantCode: connect.CodeInvalidArgument},
		{name: "comment review without a body: the daemon's invalid argument", cmd: "pr.review", args: map[string]string{"repo-slug": "o/r", "number": "7", "verdict": "comment"},
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodeInvalidArgument, errors.New("invalid argument: a body is required"))
			},
			wantReq:  &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 7, Event: comment},
			wantCode: connect.CodeInvalidArgument},
		{name: "no verdict", cmd: "pr.review", args: map[string]string{"repo-slug": "o/r", "number": "7", "body": "x"},
			wantErr: command.ErrInvalidArgs},
		{name: "unknown verdict", cmd: "pr.review", args: map[string]string{"repo-slug": "o/r", "number": "7", "verdict": "lgtm"},
			wantErr: command.ErrInvalidArgs},
		{name: "review: bad number", cmd: "pr.review", args: map[string]string{"repo-slug": "o/r", "number": "0", "verdict": "approve"},
			wantErr: command.ErrInvalidArgs, wantArg: "number"},
		{name: "approving one's own: GitHub's refusal passes through", cmd: "pr.review",
			args: map[string]string{"repo-slug": "o/r", "number": "7", "verdict": "approve"},
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodeFailedPrecondition, errors.New("Review Can not approve your own pull request"))
			},
			wantReq: &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 7, Event: approve}, wantCode: connect.CodeFailedPrecondition},
		{name: "comment", cmd: "pr.comment", args: map[string]string{"repo-slug": "O/R", "number": "7", "body": "\n thanks \n"},
			wantReq: &v1.AddPullRequestCommentRequest{RepoSlug: "O/R", Number: 7, Body: "\n thanks \n"}, wantMsg: "Commented on #7"},
		{name: "comment: blank body is the daemon's invalid argument", cmd: "pr.comment", args: map[string]string{"repo-slug": "o/r", "number": "7", "body": "  "},
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodeInvalidArgument, errors.New("invalid argument: a body is required"))
			},
			wantReq:  &v1.AddPullRequestCommentRequest{RepoSlug: "o/r", Number: 7, Body: "  "},
			wantCode: connect.CodeInvalidArgument},
		{name: "comment: no body", cmd: "pr.comment", args: map[string]string{"repo-slug": "o/r", "number": "7"},
			wantErr: command.ErrInvalidArgs},
		{name: "comment: no repo", cmd: "pr.comment", args: map[string]string{"number": "7", "body": "x"},
			wantErr: command.ErrInvalidArgs},
		{name: "comment: locked passes through", cmd: "pr.comment", args: map[string]string{"repo-slug": "o/r", "number": "7", "body": "x"},
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodeFailedPrecondition, errors.New("Unable to create comment because issue is locked."))
			},
			wantReq: &v1.AddPullRequestCommentRequest{RepoSlug: "o/r", Number: 7, Body: "x"}, wantCode: connect.CodeFailedPrecondition},
		{name: "comment: daemon's invalid argument passes through", cmd: "pr.comment", args: map[string]string{"repo-slug": "o/r", "number": "7", "body": "x"},
			backend: func(g *commandtest.Gh) {
				g.Err = connect.NewError(connect.CodeInvalidArgument, errors.New("the body is 70000 characters"))
			},
			wantReq: &v1.AddPullRequestCommentRequest{RepoSlug: "o/r", Number: 7, Body: "x"}, wantCode: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, be := newPullRequestRegistry(t)
			if tt.backend != nil {
				tt.backend(be)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, tt.cmd, tt.args)
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
				var ae *command.ArgError
				if !errors.Is(err, tt.wantErr) || tt.wantArg != "" && (!errors.As(err, &ae) || ae.Arg != tt.wantArg) {
					t.Errorf("err = %v, want %v on %q", err, tt.wantErr, tt.wantArg)
				}
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Errorf("err = %v, want code %v", err, tt.wantCode)
				}
			case err != nil:
				t.Fatal(err)
			case res.Message != tt.wantMsg:
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			case res.JSON == nil:
				t.Error("no JSON result")
			}
		})
	}
}
