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

type prThreadFixture struct {
	log     *commandtest.Calls // gh, repo and gitops requests, in call order
	reg     *command.Registry
	gh      *commandtest.Gh
	project *commandtest.Project
	thread  *commandtest.Thread
	gitops  *commandtest.GitOps
	emit    *commandtest.Emitter
}

func newPRThreadFixture(t *testing.T) *prThreadFixture {
	t.Helper()
	f := &prThreadFixture{
		reg: command.NewRegistry(),
		gh: &commandtest.Gh{Detail: &v1.PullRequestDetail{PullRequest: &v1.PullRequest{
			Number: 7, Title: "Fix it", Url: "https://github.com/o/r/pull/7", HeadRef: "fix/it", BaseRef: "main",
		}}},
		project: &commandtest.Project{Projects: []*v1.Project{{Id: "r1", GithubSlug: "o/r", Path: "/src/r", Worktrees: []*v1.Worktree{
			{Path: "/src/r", Branch: "main", IsMain: true},
			{Path: "/wt/topic", Branch: "topic"},
		}}}},
		thread: &commandtest.Thread{},
		gitops: &commandtest.GitOps{},
		emit:   &commandtest.Emitter{},
	}
	f.log = &commandtest.Calls{}
	f.gh.Shared, f.project.Shared, f.gitops.Shared = f.log, f.log, f.log
	if err := command.RegisterPullRequestThreads(f.reg, command.PullRequestThreadDeps{
		Gh: f.gh, Project: f.project, Thread: f.thread, GitOps: f.gitops, Emitter: f.emit,
	}); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestPullRequestThreadCommandsRegistered(t *testing.T) {
	f := newPRThreadFixture(t)
	for _, name := range []string{"pr.ask", "pr.explain", "pr.fix.findings"} {
		c, ok := f.reg.Get(name)
		if !ok {
			t.Fatalf("%s not registered", name)
		}
		if c.Category != "Pull Request" || c.Confirm != "" || !c.Available(command.Context{}) {
			t.Errorf("%s: category %q, confirm %q, available %v", name, c.Category, c.Confirm, c.Available(command.Context{}))
		}
	}
	if err := command.RegisterPullRequestThreads(command.NewRegistry(), command.PullRequestThreadDeps{}); err == nil {
		t.Error("registered without an Emitter")
	}
}

func TestPullRequestThreadCommands(t *testing.T) {
	detail := func(refresh bool) *v1.GetPullRequestDetailRequest {
		return &v1.GetPullRequestDetailRequest{RepoSlug: "o/r", Number: 7, Refresh: refresh}
	}
	fetch := &v1.GitFetchRequest{WorktreePath: "/src/r", Remote: "origin", Branch: "fix/it"}
	create := &v1.CreateWorktreeRequest{ProjectId: "r1", Branch: "fix/it", BaseRef: "origin/fix/it"}
	list := &v1.ListProjectsRequest{}
	addWorktree := func(wt *v1.Worktree) func(*prThreadFixture) {
		return func(f *prThreadFixture) {
			f.project.Projects[0].Worktrees = append(f.project.Projects[0].Worktrees, wt)
		}
	}
	tests := []struct {
		name    string
		cmd     string
		args    map[string]string
		uctx    command.Context
		setup   func(*prThreadFixture)
		wantReq []proto.Message // gh, repo and gitops requests, in call order
		// wantThread checks the CreateThreadRequest (prompt by prefix and contents).
		wantThread   *v1.CreateThreadRequest
		wantPrompt   string
		wantInPrompt []string
		wantMsg      string
		wantErr      error
		wantCode     connect.Code
		wantErrMsg   string
	}{
		{name: "explain in the main worktree with model and effort, not refreshed", cmd: "pr.explain",
			args:       map[string]string{"repo-slug": "o/r", "number": "7", "model": "claude-4.5-haiku[1m]", "effort": "medium"},
			wantReq:    []proto.Message{detail(false), list},
			wantThread: &v1.CreateThreadRequest{ProjectId: "r1", WorktreePath: "/src/r", Model: "claude-4.5-haiku[1m]", Effort: "medium"},
			wantPrompt: "Explain this pull request.\n\nThe pull request is #7, titled `Fix it`",
			wantMsg:    "Started thread s1 for PR #7"},
		{name: "ask in the active worktree of the clone, not refreshed", cmd: "pr.ask",
			args:       map[string]string{"repo-slug": "O/R", "number": "7", "question": "/why?"},
			uctx:       command.Context{ActiveWorktreePath: "/wt/topic"},
			wantReq:    []proto.Message{&v1.GetPullRequestDetailRequest{RepoSlug: "O/R", Number: 7}, list},
			wantThread: &v1.CreateThreadRequest{ProjectId: "r1", WorktreePath: "/wt/topic"},
			wantPrompt: "Question about PR #7:\n/why?\n\nThe pull request is #7",
			wantMsg:    "Started thread s1 for PR #7"},
		{name: "ask needs a question", cmd: "pr.ask",
			args:    map[string]string{"repo-slug": "o/r", "number": "7", "question": " \x1b "},
			wantReq: []proto.Message{},
			wantErr: command.ErrInvalidArgs},
		{name: "ask: a prompt over the hard limit fails before any change", cmd: "pr.ask",
			args:       map[string]string{"repo-slug": "o/r", "number": "7", "question": strings.Repeat("q", command.MaxPRPromptBytes)},
			wantReq:    []proto.Message{detail(false)},
			wantCode:   connect.CodeInvalidArgument,
			wantErrMsg: "the prompt for #7 would be 201 KiB, over the 200 KiB a thread can start with"},
		{name: "explain with an explicit worktree skips the repo list", cmd: "pr.explain",
			args:       map[string]string{"repo-slug": "o/r", "number": "7", "worktree": "/some/where"},
			wantReq:    []proto.Message{detail(false)},
			wantThread: &v1.CreateThreadRequest{WorktreePath: "/some/where"},
			wantPrompt: "Explain this pull request.",
			wantMsg:    "Started thread s1 for PR #7"},
		{name: "explain: no clone registered", cmd: "pr.explain",
			args:     map[string]string{"repo-slug": "a/b", "number": "7"},
			wantCode: connect.CodeFailedPrecondition},
		{name: "explain: bad number", cmd: "pr.explain",
			args:    map[string]string{"repo-slug": "o/r", "number": "0"},
			wantErr: command.ErrInvalidArgs},
		{name: "explain: pull request not found keeps its code", cmd: "pr.explain",
			args: map[string]string{"repo-slug": "o/r", "number": "7"},
			setup: func(f *prThreadFixture) {
				f.gh.Err = connect.NewError(connect.CodeNotFound, errors.New("no such pull request"))
			},
			wantCode: connect.CodeNotFound, wantErrMsg: "read #7: no such pull request"},
		{name: "explain: a repository list failure keeps its code", cmd: "pr.explain",
			args: map[string]string{"repo-slug": "o/r", "number": "7"},
			setup: func(f *prThreadFixture) {
				f.project.Err = connect.NewError(connect.CodeUnavailable, errors.New("daemon busy"))
			},
			wantReq:  []proto.Message{detail(false), list},
			wantCode: connect.CodeUnavailable, wantErrMsg: "list repositories: daemon busy"},
		{name: "fix on the head branch's worktree, refreshed, with its state in the prompt", cmd: "pr.fix.findings",
			args:       map[string]string{"repo-slug": "o/r", "number": "7"},
			setup:      addWorktree(&v1.Worktree{Path: "/wt/fix-it", Branch: "fix/it", Status: &v1.GitStatus{Upstream: "origin/fix/it", Behind: 2, Dirty: true}}),
			wantReq:    []proto.Message{detail(true), list},
			wantThread: &v1.CreateThreadRequest{ProjectId: "r1", WorktreePath: "/wt/fix-it"},
			wantPrompt: "Fix the actionable findings on PR #7",
			wantInPrompt: []string{
				"\nBefore changing anything, make sure the checkout is up to date with `origin/fix/it`",
				"\nThe checkout is 2 commits behind its upstream.\nThe checkout has uncommitted changes; do not discard them.\n",
			},
			wantMsg: "Started thread s1 for PR #7"},
		{name: "fix with an explicit worktree reads its state", cmd: "pr.fix.findings",
			args:         map[string]string{"repo-slug": "o/r", "number": "7", "worktree": "/wt/topic/"},
			setup:        func(f *prThreadFixture) { f.project.Projects[0].Worktrees[1].Status = &v1.GitStatus{Dirty: true} },
			wantReq:      []proto.Message{detail(true), list},
			wantThread:   &v1.CreateThreadRequest{WorktreePath: "/wt/topic"},
			wantPrompt:   "Fix the actionable findings on PR #7",
			wantInPrompt: []string{"\nThe checkout has uncommitted changes; do not discard them.\n"},
			wantMsg:      "Started thread s1 for PR #7"},
		{name: "fix with an explicit worktree goes ahead when the list fails", cmd: "pr.fix.findings",
			args: map[string]string{"repo-slug": "o/r", "number": "7", "worktree": "/wt/topic"},
			setup: func(f *prThreadFixture) {
				f.project.Err = connect.NewError(connect.CodeUnavailable, errors.New("daemon busy"))
			},
			wantReq:    []proto.Message{detail(true), list},
			wantThread: &v1.CreateThreadRequest{WorktreePath: "/wt/topic"},
			wantPrompt: "Fix the actionable findings on PR #7",
			wantMsg:    "Started thread s1 for PR #7"},
		{name: "fix fetches the head branch from origin, then creates its worktree", cmd: "pr.fix.findings",
			args:       map[string]string{"repo-slug": "o/r", "number": "7"},
			wantReq:    []proto.Message{detail(true), list, fetch, create},
			wantThread: &v1.CreateThreadRequest{ProjectId: "r1", WorktreePath: "/wt/fix/it"},
			wantPrompt: "Fix the actionable findings on PR #7",
			wantMsg:    "Started thread s1 for PR #7"},
		{name: "fix: a failed fetch stops before creating a worktree", cmd: "pr.fix.findings",
			args: map[string]string{"repo-slug": "o/r", "number": "7"},
			setup: func(f *prThreadFixture) {
				f.gitops.Op = &v1.GitOp{State: v1.GitOpState_GIT_OP_STATE_FAILED, Title: "Fetch r", Summary: "no network"}
			},
			wantReq:  []proto.Message{detail(true), list, fetch},
			wantCode: connect.CodeUnknown, wantErrMsg: "fetch origin/fix/it: "},
		{name: "fix: a create failure keeps its code and names the step", cmd: "pr.fix.findings",
			args: map[string]string{"repo-slug": "o/r", "number": "7"},
			setup: func(f *prThreadFixture) {
				f.project.CreateWorktreeErr = connect.NewError(connect.CodeInternal, errors.New("disk full"))
			},
			wantReq:  []proto.Message{detail(true), list, fetch, create},
			wantCode: connect.CodeInternal, wantErrMsg: "create a worktree for fix/it: disk full"},
		{name: "fix: a create conflict with nothing on the head re-lists once and fails", cmd: "pr.fix.findings",
			args: map[string]string{"repo-slug": "o/r", "number": "7"},
			setup: func(f *prThreadFixture) {
				f.project.CreateWorktreeErr = connect.NewError(connect.CodeFailedPrecondition, errors.New("already exists"))
			},
			wantReq:  []proto.Message{detail(true), list, fetch, create, list},
			wantCode: connect.CodeFailedPrecondition, wantErrMsg: "create a worktree for fix/it: already exists"},
		{name: "fix: a concurrent run created the worktree, which is used", cmd: "pr.fix.findings",
			args: map[string]string{"repo-slug": "o/r", "number": "7"},
			setup: func(f *prThreadFixture) {
				f.project.CreateWorktreeErr = connect.NewError(connect.CodeFailedPrecondition, errors.New("already exists"))
				f.project.OnCreateWorktree = func(*v1.CreateWorktreeRequest) {
					addWorktree(&v1.Worktree{Path: "/wt/other-run", Branch: "fix/it", Status: &v1.GitStatus{Behind: 1}})(f)
				}
			},
			wantReq:      []proto.Message{detail(true), list, fetch, create, list},
			wantThread:   &v1.CreateThreadRequest{ProjectId: "r1", WorktreePath: "/wt/other-run"},
			wantPrompt:   "Fix the actionable findings on PR #7",
			wantInPrompt: []string{"\nThe checkout is 1 commit behind its upstream.\n"},
			wantMsg:      "Started thread s1 for PR #7"},
		{name: "fix: a fork without a worktree", cmd: "pr.fix.findings",
			args:       map[string]string{"repo-slug": "o/r", "number": "7"},
			setup:      func(f *prThreadFixture) { f.gh.Detail.PullRequest.IsCrossRepository = true },
			wantReq:    []proto.Message{detail(true), list},
			wantCode:   connect.CodeFailedPrecondition,
			wantErrMsg: "`gh pr checkout 7`"},
		{name: "fix: a fork's head found by commit", cmd: "pr.fix.findings",
			args: map[string]string{"repo-slug": "o/r", "number": "7"},
			setup: func(f *prThreadFixture) {
				f.gh.Detail.PullRequest.IsCrossRepository, f.gh.Detail.PullRequest.HeadSha = true, "c0ffee"
				addWorktree(&v1.Worktree{Path: "/wt/fix-it", Branch: "fix/it", Head: "0ld"})(f) // same name, other commit
				addWorktree(&v1.Worktree{Path: "/wt/pr-7", Branch: "pr-7", Head: "c0ffee"})(f)
			},
			wantReq:      []proto.Message{detail(true), list},
			wantThread:   &v1.CreateThreadRequest{ProjectId: "r1", WorktreePath: "/wt/pr-7"},
			wantPrompt:   "Fix the actionable findings on PR #7",
			wantInPrompt: []string{"on the contributor's fork (for example with `gh pr checkout 7`)"},
			wantMsg:      "Started thread s1 for PR #7"},
		{name: "thread create failure keeps its code", cmd: "pr.explain",
			args: map[string]string{"repo-slug": "o/r", "number": "7"},
			setup: func(f *prThreadFixture) {
				f.thread.Err = connect.NewError(connect.CodeFailedPrecondition, errors.New("not trusted"))
			},
			wantCode: connect.CodeFailedPrecondition, wantErrMsg: "start thread: not trusted"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newPRThreadFixture(t)
			if tt.setup != nil {
				tt.setup(f)
			}
			res, err := f.reg.Invoke(context.Background(), tt.uctx, tt.cmd, tt.args)
			if tt.wantReq != nil {
				got := f.log.Requests()
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
				if ce := new(connect.Error); !errors.As(err, &ce) || !strings.Contains(ce.Message(), tt.wantErrMsg) {
					t.Errorf("err = %v, want a message containing %q", err, tt.wantErrMsg)
				}
			case err != nil:
				t.Fatal(err)
			}
			if err != nil {
				if f.thread.Err == nil && len(f.thread.Requests()) != 0 {
					t.Errorf("thread requests = %v, want none", f.thread.Requests())
				}
				if len(f.emit.Intents()) != 0 {
					t.Errorf("intents = %v, want none", f.emit.Intents())
				}
				return
			}
			sessReqs := f.thread.Requests()
			if len(sessReqs) != 1 {
				t.Fatalf("thread requests = %v", sessReqs)
			}
			got := proto.CloneOf(sessReqs[0].(*v1.CreateThreadRequest))
			if !strings.HasPrefix(got.GetInitialPrompt(), tt.wantPrompt) {
				t.Errorf("prompt = %q, want prefix %q", got.GetInitialPrompt(), tt.wantPrompt)
			}
			for _, want := range tt.wantInPrompt {
				if !strings.Contains(got.GetInitialPrompt(), want) {
					t.Errorf("prompt = %q, want it to contain %q", got.GetInitialPrompt(), want)
				}
			}
			got.InitialPrompt = ""
			if !proto.Equal(got, tt.wantThread) {
				t.Errorf("create = %v, want %v", got, tt.wantThread)
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if s, ok := res.JSON.(*v1.Thread); !ok || s.GetId() != "s1" {
				t.Errorf("JSON = %v, want the thread", res.JSON)
			}
			intents := f.emit.Intents()
			if len(intents) != 1 || intents[0].GetFocusThread().GetThreadId() != "s1" {
				t.Errorf("intents = %v, want FocusThread s1", intents)
			}
		})
	}
}
