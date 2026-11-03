package command_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

func TestPullRequestTask(t *testing.T) {
	detail := func(slug string, refresh bool) *v1.GetPullRequestDetailRequest {
		return &v1.GetPullRequestDetailRequest{RepoSlug: slug, Number: 7, Refresh: refresh}
	}
	list := &v1.ListProjectsRequest{}
	fetch := func(at string) *v1.GitFetchRequest {
		return &v1.GitFetchRequest{WorktreePath: at, Remote: "origin", Branch: "fix/it"}
	}
	create := func(project string) *v1.CreateWorktreeRequest {
		return &v1.CreateWorktreeRequest{ProjectId: project, Branch: "fix/it", BaseRef: "origin/fix/it"}
	}
	addWorktree := func(wt *v1.Worktree) func(*prThreadFixture) {
		return func(f *prThreadFixture) {
			f.project.Projects[0].Worktrees = append(f.project.Projects[0].Worktrees, wt)
		}
	}
	fork := func(f *prThreadFixture) {
		f.gh.Detail.PullRequest.IsCrossRepository, f.gh.Detail.PullRequest.HeadSha = true, "c0ffee"
	}
	args := func(slug, kind string, more ...string) map[string]string {
		m := map[string]string{"repo-slug": slug, "number": "7", "kind": kind}
		for i := 0; i+1 < len(more); i += 2 {
			m[more[i]] = more[i+1]
		}
		return m
	}
	tests := []struct {
		name  string
		args  map[string]string
		uctx  command.Context
		setup func(*prThreadFixture)
		// wantReq are the gh, project and gitops requests in call order; wantThread the
		// thread requests (the prompt checked by prefix and contents, then cleared).
		wantReq      []proto.Message
		wantThread   []proto.Message
		wantPrompt   string
		wantInPrompt []string
		wantCloned   []string
		wantMsg      string
		wantJSON     command.PRTaskResult
		wantFocus    bool
		wantErr      error
		wantCode     connect.Code
		wantErrMsg   string
	}{
		{name: "checks: the head branch's worktree is reused, refreshed, with its state",
			args:         args("o/r", "checks", "model", "claude-4.5-haiku[1m]", "effort", "low"),
			setup:        addWorktree(&v1.Worktree{Path: "/wt/fix-it", Branch: "fix/it", Status: &v1.GitStatus{Behind: 2}}),
			wantReq:      []proto.Message{detail("o/r", true), list},
			wantThread:   []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", WorktreePath: "/wt/fix-it", Model: "claude-4.5-haiku[1m]", Effort: "low"}},
			wantPrompt:   "Fix the failing checks on PR `o/r#7`, titled `Fix it`",
			wantInPrompt: []string{"\nThe checkout is 2 commits behind its upstream.\n"},
			wantMsg:      "Started thread s1 for PR #7",
			wantJSON:     command.PRTaskResult{ThreadID: "s1", ProjectID: "r1", WorktreePath: "/wt/fix-it"},
			wantFocus:    true},
		{name: "conflicts: no worktree on the head, one is fetched and created",
			args:       args("o/r", "conflicts"),
			wantReq:    []proto.Message{detail("o/r", true), list, fetch("/src/r"), create("r1")},
			wantThread: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", WorktreePath: "/wt/fix/it"}},
			wantPrompt: "Resolve the merge conflicts on PR `o/r#7`",
			wantMsg:    "Started thread s1 for PR #7",
			wantJSON:   command.PRTaskResult{ThreadID: "s1", ProjectID: "r1", WorktreePath: "/wt/fix/it", CreatedWorktree: true},
			wantFocus:  true},
		{name: "not a project: cloned first, then the head's worktree is created in the clone",
			args:       args("a/b", "behind", "focus", "false"),
			setup:      func(f *prThreadFixture) { f.clone = &v1.Project{Id: "p-new", Path: "/cf/projects/a/b"} },
			wantReq:    []proto.Message{detail("a/b", true), list, fetch("/cf/projects/a/b"), create("p-new")},
			wantCloned: []string{"a/b"},
			wantThread: []proto.Message{&v1.CreateThreadRequest{ProjectId: "p-new", WorktreePath: "/wt/fix/it"}},
			wantPrompt: "Bring the branch up to date with its base on PR `a/b#7`",
			wantMsg:    "Cloned a/b and started thread s1 for PR #7",
			wantJSON:   command.PRTaskResult{ThreadID: "s1", ProjectID: "p-new", WorktreePath: "/wt/fix/it", CreatedWorktree: true, Cloned: true}},
		{name: "not a project: a failed clone keeps its code and starts nothing",
			args:       args("a/b", "checks"),
			setup:      func(f *prThreadFixture) { f.cloneErr = connect.NewError(connect.CodeAlreadyExists, errors.New("destination exists")) },
			wantReq:    []proto.Message{detail("a/b", true), list},
			wantCloned: []string{"a/b"},
			wantCode:   connect.CodeAlreadyExists, wantErrMsg: "clone a/b: destination exists"},
		{name: "not a project: a fork's push task is refused before cloning",
			args:     args("a/b", "conversations"),
			setup:    fork,
			wantReq:  []proto.Message{detail("a/b", true), list},
			wantCode: connect.CodeFailedPrecondition, wantErrMsg: "comes from a fork and no worktree of a/b has its head checked out"},
		{name: "fork: a push task without the head checked out is refused, as fix.findings",
			args:     args("o/r", "review"),
			setup:    fork,
			wantReq:  []proto.Message{detail("o/r", true), list},
			wantCode: connect.CodeFailedPrecondition, wantErrMsg: "`gh pr checkout 7`"},
		{name: "fork: a push task runs where the head is checked out",
			args: args("o/r", "review"),
			setup: func(f *prThreadFixture) {
				fork(f)
				addWorktree(&v1.Worktree{Path: "/wt/pr-7", Branch: "pr-7", Head: "c0ffee"})(f)
			},
			wantReq:      []proto.Message{detail("o/r", true), list},
			wantThread:   []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", WorktreePath: "/wt/pr-7"}},
			wantPrompt:   "Address the requested changes on PR `o/r#7`",
			wantInPrompt: []string{"on the contributor's fork (for example with `gh pr checkout 7 --repo o/r`)"},
			wantMsg:      "Started thread s1 for PR #7",
			wantJSON:     command.PRTaskResult{ThreadID: "s1", ProjectID: "r1", WorktreePath: "/wt/pr-7"},
			wantFocus:    true},
		{name: "review-request: a fork without a worktree runs off the head in the main worktree, not refreshed",
			args:         args("o/r", "review-request"),
			setup:        fork,
			wantReq:      []proto.Message{detail("o/r", false), list},
			wantThread:   []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", WorktreePath: "/src/r"}},
			wantPrompt:   "Review PR `o/r#7`",
			wantInPrompt: []string{"This checkout is not on the PR's branch; do not switch it.", "`git fetch origin pull/7/head`"},
			wantMsg:      "Started thread s1 for PR #7",
			wantJSON:     command.PRTaskResult{ThreadID: "s1", ProjectID: "r1", WorktreePath: "/src/r"},
			wantFocus:    true},
		{name: "review-request: a same-repository head gets its worktree",
			args:         args("o/r", "review-request"),
			wantReq:      []proto.Message{detail("o/r", false), list, fetch("/src/r"), create("r1")},
			wantThread:   []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", WorktreePath: "/wt/fix/it"}},
			wantPrompt:   "Review PR `o/r#7`",
			wantInPrompt: []string{"This checkout is on the PR's branch"},
			wantMsg:      "Started thread s1 for PR #7",
			wantJSON:     command.PRTaskResult{ThreadID: "s1", ProjectID: "r1", WorktreePath: "/wt/fix/it", CreatedWorktree: true},
			wantFocus:    true},
		{name: "thread: sent into it as a follow-up, nothing listed, created or focused",
			args:  args("o/r", "checks", "thread", "s-lead0000001"),
			uctx:  command.Context{ActiveView: "thread", ActiveThreadID: "s-lead0000001"},
			setup: func(f *prThreadFixture) { f.thread.Others = []*v1.Thread{{Id: "s-lead0000001", Name: "Lead"}} },
			wantReq: []proto.Message{detail("o/r", true)},
			wantThread: []proto.Message{
				&v1.GetThreadRequest{Id: "s-lead0000001"},
				&v1.SendThreadMessageRequest{ThreadId: "s-lead0000001"},
			},
			wantPrompt:   "Follow-up task: fix the failing checks on PR `o/r#7`",
			wantInPrompt: []string{"check that it is on `fix/it` (`git branch --show-current`)"},
			wantMsg:      "Sent to Lead (s-lead0000001)",
			wantJSON:     command.PRTaskResult{ThreadID: "s-lead0000001", Sent: true}},
		{name: "thread: from a thread's CLI the message is that thread's",
			args:  args("o/r", "review-request", "thread", "s-other000001"),
			uctx:  command.Context{ActiveThreadID: "s-lead0000001"},
			wantReq: []proto.Message{detail("o/r", false)},
			wantThread: []proto.Message{
				&v1.GetThreadRequest{Id: "s-other000001"},
				&v1.SendThreadMessageRequest{ThreadId: "s-other000001", ByThreadId: "s-lead0000001"},
			},
			wantPrompt:   "Follow-up task: review PR `o/r#7`",
			wantInPrompt: []string{"Do not switch this thread's checkout to the PR's branch."},
			wantMsg:      "Sent to s-other000001",
			wantJSON:     command.PRTaskResult{ThreadID: "s-other000001", Sent: true}},
		{name: "thread: an unknown thread keeps its code and sends nothing",
			args: args("o/r", "checks", "thread", "s-gone"),
			setup: func(f *prThreadFixture) {
				f.thread.Err = connect.NewError(connect.CodeNotFound, errors.New("no thread s-gone"))
			},
			wantReq:    []proto.Message{detail("o/r", true)},
			wantThread: []proto.Message{&v1.GetThreadRequest{Id: "s-gone"}},
			wantCode:   connect.CodeNotFound, wantErrMsg: "find thread s-gone: no thread s-gone"},
		{name: "worktree: used as is, even for a repository that is no project, nothing cloned",
			args:       args("a/b", "checks", "worktree", "/some/where/"),
			wantReq:    []proto.Message{detail("a/b", true), list},
			wantThread: []proto.Message{&v1.CreateThreadRequest{WorktreePath: "/some/where"}},
			wantPrompt: "Fix the failing checks on PR `a/b#7`",
			wantMsg:    "Started thread s1 for PR #7",
			wantJSON:   command.PRTaskResult{ThreadID: "s1", WorktreePath: "/some/where"},
			wantFocus:  true},
		{name: "worktree: a list failure only loses the status; a review there reads off the head",
			args: args("o/r", "review-request", "worktree", "/wt/topic"),
			setup: func(f *prThreadFixture) {
				f.project.Err = connect.NewError(connect.CodeUnavailable, errors.New("busy"))
			},
			wantReq:      []proto.Message{detail("o/r", false), list},
			wantThread:   []proto.Message{&v1.CreateThreadRequest{WorktreePath: "/wt/topic"}},
			wantPrompt:   "Review PR `o/r#7`",
			wantInPrompt: []string{"This checkout is not on the PR's branch; do not switch it."},
			wantMsg:      "Started thread s1 for PR #7",
			wantJSON:     command.PRTaskResult{ThreadID: "s1", WorktreePath: "/wt/topic"},
			wantFocus:    true},
		{name: "worktree: a review in a registered worktree on the head reads it there",
			args:         args("o/r", "review-request", "worktree", "/wt/fix-it"),
			setup:        addWorktree(&v1.Worktree{Path: "/wt/fix-it", Branch: "fix/it"}),
			wantReq:      []proto.Message{detail("o/r", false), list},
			wantThread:   []proto.Message{&v1.CreateThreadRequest{WorktreePath: "/wt/fix-it"}},
			wantPrompt:   "Review PR `o/r#7`",
			wantInPrompt: []string{"This checkout is on the PR's branch"},
			wantMsg:      "Started thread s1 for PR #7",
			wantJSON:     command.PRTaskResult{ThreadID: "s1", WorktreePath: "/wt/fix-it"},
			wantFocus:    true},
		{name: "worktree and thread together", args: args("o/r", "checks", "thread", "s-lead0000001", "worktree", "/wt/topic"),
			wantReq: []proto.Message{detail("o/r", true)}, wantErr: command.ErrInvalidArgs},
		{name: "an unknown kind", args: args("o/r", "rebase"), wantReq: []proto.Message{}, wantErr: command.ErrInvalidArgs},
		{name: "a bad number", args: map[string]string{"repo-slug": "o/r", "number": "0", "kind": "checks"},
			wantReq: []proto.Message{}, wantErr: command.ErrInvalidArgs},
		{name: "a failed read keeps its code",
			args: args("o/r", "checks"),
			setup: func(f *prThreadFixture) {
				f.gh.Err = connect.NewError(connect.CodeUnavailable, errors.New("502"))
			},
			wantCode: connect.CodeUnavailable, wantErrMsg: "read #7: 502"},
		{name: "a project list failure keeps its code",
			args: args("o/r", "checks"),
			setup: func(f *prThreadFixture) {
				f.project.Err = connect.NewError(connect.CodeUnavailable, errors.New("busy"))
			},
			wantReq:  []proto.Message{detail("o/r", true), list},
			wantCode: connect.CodeUnavailable, wantErrMsg: "list projects: busy"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newPRThreadFixture(t)
			if tt.setup != nil {
				tt.setup(f)
			}
			res, err := f.reg.Invoke(context.Background(), tt.uctx, "pr.task", tt.args)
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
			if !slices.Equal(f.cloned, tt.wantCloned) {
				t.Errorf("cloned = %v, want %v", f.cloned, tt.wantCloned)
			}
			threadReqs := f.thread.Requests()
			if len(threadReqs) != len(tt.wantThread) {
				t.Fatalf("thread requests = %v, want %v", threadReqs, tt.wantThread)
			}
			for i, req := range threadReqs {
				req = proto.Clone(req)
				var (
					prompt    string
					hasPrompt = true
				)
				switch m := req.(type) {
				case *v1.CreateThreadRequest:
					prompt, m.InitialPrompt = m.GetInitialPrompt(), ""
				case *v1.SendThreadMessageRequest:
					prompt, m.Text = m.GetText(), ""
				default:
					hasPrompt = false
				}
				if hasPrompt {
					if !strings.HasPrefix(prompt, tt.wantPrompt) {
						t.Errorf("prompt = %q, want prefix %q", prompt, tt.wantPrompt)
					}
					for _, want := range tt.wantInPrompt {
						if !strings.Contains(prompt, want) {
							t.Errorf("prompt = %q, want it to contain %q", prompt, want)
						}
					}
				}
				if !proto.Equal(req, tt.wantThread[i]) {
					t.Errorf("thread request %d = %v, want %v", i, req, tt.wantThread[i])
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
			intents := f.emit.Intents()
			if focused := len(intents) == 1 && intents[0].GetFocusThread().GetThreadId() == "s1"; focused != tt.wantFocus || len(intents) > 1 {
				t.Errorf("intents = %v, want focus %v", intents, tt.wantFocus)
			}
			if err != nil {
				return
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if got, ok := res.JSON.(command.PRTaskResult); !ok || got != tt.wantJSON {
				t.Errorf("JSON = %#v, want %#v", res.JSON, tt.wantJSON)
			}
		})
	}
}
