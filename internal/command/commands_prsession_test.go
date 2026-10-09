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

type prSessionFixture struct {
	reg     *command.Registry
	gh      *commandtest.Gh
	repo    *commandtest.Repo
	session *commandtest.Session
	gitops  *commandtest.GitOps
	emit    *commandtest.Emitter
}

func newPRSessionFixture(t *testing.T) *prSessionFixture {
	t.Helper()
	f := &prSessionFixture{
		reg: command.NewRegistry(),
		gh: &commandtest.Gh{Detail: &v1.PullRequestDetail{PullRequest: &v1.PullRequest{
			Number: 7, Title: "Fix it", Url: "https://github.com/o/r/pull/7", HeadRef: "fix/it", BaseRef: "main",
		}}},
		repo: &commandtest.Repo{Repos: []*v1.Repo{{Id: "r1", GithubSlug: "o/r", Path: "/src/r", Worktrees: []*v1.Worktree{
			{Path: "/src/r", Branch: "main", IsMain: true},
			{Path: "/wt/topic", Branch: "topic"},
		}}}},
		session: &commandtest.Session{},
		gitops:  &commandtest.GitOps{},
		emit:    &commandtest.Emitter{},
	}
	if err := command.RegisterPullRequestSessions(f.reg, command.PullRequestSessionDeps{
		Gh: f.gh, Repo: f.repo, Session: f.session, GitOps: f.gitops, Emitter: f.emit,
	}); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestPullRequestSessionCommandsRegistered(t *testing.T) {
	f := newPRSessionFixture(t)
	for _, name := range []string{"pr.ask", "pr.explain", "pr.fix.findings"} {
		c, ok := f.reg.Get(name)
		if !ok {
			t.Fatalf("%s not registered", name)
		}
		if c.Category != "Pull Request" || c.Confirm != "" || !c.Available(command.Context{}) {
			t.Errorf("%s: category %q, confirm %q, available %v", name, c.Category, c.Confirm, c.Available(command.Context{}))
		}
	}
	if err := command.RegisterPullRequestSessions(command.NewRegistry(), command.PullRequestSessionDeps{}); err == nil {
		t.Error("registered without an Emitter")
	}
}

func TestPullRequestSessionCommands(t *testing.T) {
	tests := []struct {
		name    string
		cmd     string
		args    map[string]string
		uctx    command.Context
		setup   func(*prSessionFixture)
		wantReq []proto.Message // across gh, repo, gitops, session, in that order
		// wantSession checks the CreateSessionRequest (prompt by prefix).
		wantSession *v1.CreateSessionRequest
		wantPrompt  string
		wantMsg     string
		wantErr     error
		wantCode    connect.Code
	}{
		{name: "explain in the main worktree with model and effort", cmd: "pr.explain",
			args:        map[string]string{"repo-slug": "o/r", "number": "7", "model": "haiku", "effort": "medium"},
			wantSession: &v1.CreateSessionRequest{RepoId: "r1", WorktreePath: "/src/r", Model: "haiku", Effort: "medium"},
			wantPrompt:  "Explain this pull request.\n\nThe pull request is #7, titled `Fix it`",
			wantMsg:     "Started session s1 for PR #7"},
		{name: "ask in the active worktree of the clone", cmd: "pr.ask",
			args:        map[string]string{"repo-slug": "O/R", "number": "7", "question": "why?"},
			uctx:        command.Context{ActiveWorktreePath: "/wt/topic"},
			wantSession: &v1.CreateSessionRequest{RepoId: "r1", WorktreePath: "/wt/topic"},
			wantPrompt:  "why?\n\nThe pull request is #7",
			wantMsg:     "Started session s1 for PR #7"},
		{name: "ask needs a question", cmd: "pr.ask",
			args:    map[string]string{"repo-slug": "o/r", "number": "7", "question": " \x1b "},
			wantErr: command.ErrInvalidArgs},
		{name: "explain with an explicit worktree skips the repo list", cmd: "pr.explain",
			args:        map[string]string{"repo-slug": "o/r", "number": "7", "worktree": "/some/where"},
			wantSession: &v1.CreateSessionRequest{WorktreePath: "/some/where"},
			wantPrompt:  "Explain this pull request.",
			wantMsg:     "Started session s1 for PR #7"},
		{name: "explain: no clone registered", cmd: "pr.explain",
			args:     map[string]string{"repo-slug": "a/b", "number": "7"},
			wantCode: connect.CodeFailedPrecondition},
		{name: "explain: bad number", cmd: "pr.explain",
			args:    map[string]string{"repo-slug": "o/r", "number": "0"},
			wantErr: command.ErrInvalidArgs},
		{name: "explain: pull request not found keeps its code", cmd: "pr.explain",
			args: map[string]string{"repo-slug": "o/r", "number": "7"},
			setup: func(f *prSessionFixture) {
				f.gh.Err = connect.NewError(connect.CodeNotFound, errors.New("no such pull request"))
			},
			wantCode: connect.CodeNotFound},
		{name: "fix on the head branch's worktree, refreshed", cmd: "pr.fix.findings",
			args: map[string]string{"repo-slug": "o/r", "number": "7"},
			setup: func(f *prSessionFixture) {
				f.repo.Repos[0].Worktrees = append(f.repo.Repos[0].Worktrees, &v1.Worktree{Path: "/wt/fix-it", Branch: "fix/it"})
			},
			wantReq:     []proto.Message{&v1.GetPullRequestDetailRequest{RepoSlug: "o/r", Number: 7, Refresh: true}, &v1.ListReposRequest{}},
			wantSession: &v1.CreateSessionRequest{RepoId: "r1", WorktreePath: "/wt/fix-it"},
			wantPrompt:  "Fix the actionable findings on PR #7",
			wantMsg:     "Started session s1 for PR #7"},
		{name: "fix creates the head branch's worktree after a fetch", cmd: "pr.fix.findings",
			args: map[string]string{"repo-slug": "o/r", "number": "7"},
			wantReq: []proto.Message{
				&v1.GetPullRequestDetailRequest{RepoSlug: "o/r", Number: 7, Refresh: true},
				&v1.ListReposRequest{},
				&v1.CreateWorktreeRequest{RepoId: "r1", Branch: "fix/it", BaseRef: "origin/fix/it"},
				&v1.GitFetchRequest{WorktreePath: "/src/r"},
			},
			wantSession: &v1.CreateSessionRequest{RepoId: "r1", WorktreePath: "/wt/fix/it"},
			wantPrompt:  "Fix the actionable findings on PR #7",
			wantMsg:     "Started session s1 for PR #7"},
		{name: "fix: a failed fetch stops before creating a worktree", cmd: "pr.fix.findings",
			args: map[string]string{"repo-slug": "o/r", "number": "7"},
			setup: func(f *prSessionFixture) {
				f.gitops.Op = &v1.GitOp{State: v1.GitOpState_GIT_OP_STATE_FAILED, Title: "Fetch r", Summary: "no network"}
			},
			wantReq: []proto.Message{
				&v1.GetPullRequestDetailRequest{RepoSlug: "o/r", Number: 7, Refresh: true},
				&v1.ListReposRequest{},
				&v1.GitFetchRequest{WorktreePath: "/src/r"},
			},
			wantCode: connect.CodeUnknown},
		{name: "fix: a fork without a worktree", cmd: "pr.fix.findings",
			args:     map[string]string{"repo-slug": "o/r", "number": "7"},
			setup:    func(f *prSessionFixture) { f.gh.Detail.PullRequest.IsCrossRepository = true },
			wantCode: connect.CodeFailedPrecondition},
		{name: "session create failure keeps its code", cmd: "pr.explain",
			args: map[string]string{"repo-slug": "o/r", "number": "7"},
			setup: func(f *prSessionFixture) {
				f.session.Err = connect.NewError(connect.CodeFailedPrecondition, errors.New("not trusted"))
			},
			wantCode: connect.CodeFailedPrecondition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newPRSessionFixture(t)
			if tt.setup != nil {
				tt.setup(f)
			}
			res, err := f.reg.Invoke(context.Background(), tt.uctx, tt.cmd, tt.args)
			if tt.wantReq != nil {
				got := append(append(f.gh.Requests(), f.repo.Requests()...), f.gitops.Requests()...)
				if len(got) != len(tt.wantReq) {
					t.Fatalf("requests = %v, want %v", got, tt.wantReq)
				}
				for i := range got {
					if !proto.Equal(got[i], tt.wantReq[i]) {
						t.Errorf("request %d = %v, want %v", i, got[i], tt.wantReq[i])
					}
				}
			}
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
			case err != nil:
				t.Fatal(err)
			}
			if err != nil {
				if f.session.Err == nil && len(f.session.Requests()) != 0 {
					t.Errorf("session requests = %v, want none", f.session.Requests())
				}
				if len(f.emit.Intents()) != 0 {
					t.Errorf("intents = %v, want none", f.emit.Intents())
				}
				return
			}
			sessReqs := f.session.Requests()
			if len(sessReqs) != 1 {
				t.Fatalf("session requests = %v", sessReqs)
			}
			got := proto.CloneOf(sessReqs[0].(*v1.CreateSessionRequest))
			if !strings.HasPrefix(got.GetInitialPrompt(), tt.wantPrompt) {
				t.Errorf("prompt = %q, want prefix %q", got.GetInitialPrompt(), tt.wantPrompt)
			}
			got.InitialPrompt = ""
			if !proto.Equal(got, tt.wantSession) {
				t.Errorf("create = %v, want %v", got, tt.wantSession)
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if s, ok := res.JSON.(*v1.Session); !ok || s.GetId() != "s1" {
				t.Errorf("JSON = %v, want the session", res.JSON)
			}
			intents := f.emit.Intents()
			if len(intents) != 1 || intents[0].GetFocusSession().GetSessionId() != "s1" {
				t.Errorf("intents = %v, want FocusSession s1", intents)
			}
		})
	}
}
