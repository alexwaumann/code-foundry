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
		// wantNotInPrompt must not be in the prompt.
		wantNotInPrompt []string
		wantCloned      []string
		wantMsg         string
		wantJSON        command.PRTaskResult
		wantFocus       bool
		wantExit        int
		wantErr         error
		wantCode        connect.Code
		wantErrMsg      string
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
		{name: "renamed: GitHub's current name finds the clone, nothing cloned",
			args: args("old/r", "checks"),
			setup: func(f *prThreadFixture) {
				f.gh.Detail.PullRequest.RepoSlug = "o/r"
				addWorktree(&v1.Worktree{Path: "/wt/fix-it", Branch: "fix/it"})(f)
			},
			wantReq:    []proto.Message{detail("old/r", true), list},
			wantThread: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", WorktreePath: "/wt/fix-it"}},
			wantPrompt: "Fix the failing checks on PR `o/r#7`",
			wantMsg:    "Started thread s1 for PR #7",
			wantJSON:   command.PRTaskResult{ThreadID: "s1", ProjectID: "r1", WorktreePath: "/wt/fix-it"},
			wantFocus:  true},
		{name: "renamed and not a project: GitHub's current name is cloned",
			args: args("old/b", "behind", "focus", "false"),
			setup: func(f *prThreadFixture) {
				f.gh.Detail.PullRequest.RepoSlug = "a/b"
				f.clone = &v1.Project{Id: "p-new", Path: "/cf/projects/a/b", GithubSlug: "a/b"}
			},
			wantReq:    []proto.Message{detail("old/b", true), list, fetch("/cf/projects/a/b"), create("p-new")},
			wantCloned: []string{"a/b"},
			wantThread: []proto.Message{&v1.CreateThreadRequest{ProjectId: "p-new", WorktreePath: "/wt/fix/it"}},
			wantPrompt: "Bring the branch up to date with its base on PR `a/b#7`",
			wantMsg:    "Cloned a/b and started thread s1 for PR #7",
			wantJSON:   command.PRTaskResult{ThreadID: "s1", ProjectID: "p-new", WorktreePath: "/wt/fix/it", CreatedWorktree: true, Cloned: true}},
		{name: "not recognised: an origin on an SSH host alias is refused, not cloned again",
			args: args("A/B", "checks"),
			setup: func(f *prThreadFixture) {
				f.project.Projects = append(f.project.Projects, &v1.Project{Id: "p-b", Name: "b", Path: "/src/b", OriginPath: "a/b.git"})
			},
			wantReq:  []proto.Message{detail("A/B", true), list},
			wantCode: connect.CodeFailedPrecondition, wantErrMsg: "project b looks like a clone of A/B (its origin is …/a/b.git) but its origin is not a github.com URL"},
		{name: "not recognised: an origin naming GitHub's current name is refused too",
			args: args("old/b", "review-request"),
			setup: func(f *prThreadFixture) {
				f.gh.Detail.PullRequest.RepoSlug = "a/b"
				f.project.Projects = append(f.project.Projects, &v1.Project{Id: "p-b", Path: "/src/b", OriginPath: "/git/a/b"})
			},
			wantReq:  []proto.Message{detail("old/b", false), list},
			wantCode: connect.CodeFailedPrecondition, wantErrMsg: "project /src/b looks like a clone of a/b"},
		{name: "not a project: a failed clone keeps its code and starts nothing",
			args: args("a/b", "checks"),
			setup: func(f *prThreadFixture) {
				f.cloneErr = connect.NewError(connect.CodeAlreadyExists, errors.New("destination exists"))
			},
			wantReq:    []proto.Message{detail("a/b", true), list},
			wantCloned: []string{"a/b"},
			wantCode:   connect.CodeAlreadyExists, wantErrMsg: "clone a/b: destination exists"},
		{name: "not a project: a fork's push task is refused before cloning",
			args:     args("a/b", "conversations"),
			setup:    fork,
			wantReq:  []proto.Message{detail("a/b", true), list},
			wantCode: connect.CodeFailedPrecondition, wantErrMsg: "#7 comes from a fork and a/b is not a project yet: clone it (`code-foundry project clone a/b`)"},
		{name: "not a project: a push task without a head branch is refused before cloning",
			args:     args("a/b", "checks"),
			setup:    func(f *prThreadFixture) { f.gh.Detail.PullRequest.HeadRef = "" },
			wantReq:  []proto.Message{detail("a/b", true), list},
			wantCode: connect.CodeFailedPrecondition, wantErrMsg: "#7 has no head branch to check out: pass --worktree"},
		{name: "not a project: a step failing after the clone says the clone stays",
			args: args("a/b", "checks"),
			setup: func(f *prThreadFixture) {
				f.clone = &v1.Project{Id: "p-new", Path: "/cf/projects/a/b"}
				f.gitops.Err = connect.NewError(connect.CodeUnavailable, errors.New("network down"))
			},
			wantReq:    []proto.Message{detail("a/b", true), list, fetch("/cf/projects/a/b")},
			wantCloned: []string{"a/b"},
			wantCode:   connect.CodeUnavailable,
			wantErrMsg: "cloned a/b into /cf/projects/a/b, which stays a project: fetch origin/fix/it: network down"},
		{name: "not a project: a failed thread start after the clone says the clone stays",
			args: args("a/b", "review-request"),
			setup: func(f *prThreadFixture) {
				fork(f)
				f.clone = &v1.Project{Id: "p-new", Path: "/cf/projects/a/b"}
				f.thread.Err = connect.NewError(connect.CodeResourceExhausted, errors.New("too many threads"))
			},
			wantReq:    []proto.Message{detail("a/b", false), list},
			wantCloned: []string{"a/b"},
			wantThread: []proto.Message{&v1.CreateThreadRequest{ProjectId: "p-new", WorktreePath: "/cf/projects/a/b"}},
			wantPrompt: "Review PR `a/b#7`",
			wantCode:   connect.CodeResourceExhausted,
			wantErrMsg: "cloned a/b into /cf/projects/a/b, which stays a project: start thread: too many threads"},
		{name: "not a project: a fork's review-request clones, then reads off the head in the main worktree",
			args: args("a/b", "review-request"),
			setup: func(f *prThreadFixture) {
				fork(f)
				f.clone = &v1.Project{Id: "p-new", Path: "/cf/projects/a/b", GithubSlug: "a/b", Worktrees: []*v1.Worktree{
					{Path: "/cf/projects/a/b", Branch: "main", IsMain: true},
				}}
			},
			wantReq:      []proto.Message{detail("a/b", false), list},
			wantCloned:   []string{"a/b"},
			wantThread:   []proto.Message{&v1.CreateThreadRequest{ProjectId: "p-new", WorktreePath: "/cf/projects/a/b"}},
			wantPrompt:   "Review PR `a/b#7`",
			wantInPrompt: []string{"This checkout is not on the PR's branch; do not switch it.", "`git fetch origin pull/7/head`"},
			wantMsg:      "Cloned a/b and started thread s1 for PR #7",
			wantJSON:     command.PRTaskResult{ThreadID: "s1", ProjectID: "p-new", WorktreePath: "/cf/projects/a/b", Cloned: true},
			wantFocus:    true},
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
			args: args("o/r", "checks", "thread", "s-lead0000001"),
			uctx: command.Context{ActiveView: "thread", ActiveThreadID: "s-lead0000001"},
			setup: func(f *prThreadFixture) {
				f.thread.Others, f.thread.SentOrdinal = []*v1.Thread{{Id: "s-lead0000001", Name: "Lead"}}, 12
			},
			wantReq: []proto.Message{detail("o/r", true)},
			wantThread: []proto.Message{
				&v1.GetThreadRequest{Id: "s-lead0000001"},
				&v1.PullRequestOwnerRequest{Id: "s-lead0000001", RepoSlugs: []string{"o/r"}, Number: 7},
				&v1.SendThreadMessageRequest{ThreadId: "s-lead0000001"},
			},
			wantPrompt:   "Follow-up task: fix the failing checks on PR `o/r#7`",
			wantInPrompt: []string{"check that it is on `fix/it` (`git branch --show-current`)"},
			wantMsg:      "Sent to Lead (s-lead0000001) (#12); wait with: code-foundry thread wait s-lead0000001 --after 12",
			wantJSON:     command.PRTaskResult{ThreadID: "s-lead0000001", Sent: true, Ordinal: 12}},
		{name: "thread: from a thread's CLI the message is that thread's, and its subscription is the hint",
			args: args("o/r", "review-request", "thread", "s-other000001"),
			uctx: command.Context{ActiveThreadID: "s-lead0000001"},
			setup: func(f *prThreadFixture) {
				f.thread.SentOrdinal = 3
				f.thread.Subscriptions = []*v1.ThreadSubscription{{
					Id: "w-1", SubscriberThreadId: "s-lead0000001", TargetId: "s-other000001",
					Target:    v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_THREAD,
					Condition: v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED,
				}}
			},
			wantReq: []proto.Message{detail("o/r", false)},
			wantThread: []proto.Message{
				&v1.GetThreadRequest{Id: "s-other000001"},
				&v1.PullRequestOwnerRequest{Id: "s-other000001", RepoSlugs: []string{"o/r"}, Number: 7},
				&v1.SendThreadMessageRequest{ThreadId: "s-other000001", ByThreadId: "s-lead0000001"},
				&v1.ListThreadSubscriptionsRequest{SubscriberThreadId: "s-lead0000001"},
			},
			wantPrompt:   "Follow-up task: review PR `o/r#7`",
			wantInPrompt: []string{"Do not switch this thread's checkout to the PR's branch."},
			wantMsg:      "Sent to s-other000001 (#3); you are subscribed (w-1): end your turn; it wakes you",
			wantJSON:     command.PRTaskResult{ThreadID: "s-other000001", Sent: true, Ordinal: 3}},
		{name: "thread: without an ordinal there is no wait hint",
			args:       args("o/r", "checks", "thread", "s-lead0000001"),
			wantReq:    []proto.Message{detail("o/r", true)},
			wantThread: []proto.Message{&v1.GetThreadRequest{Id: "s-lead0000001"}, &v1.PullRequestOwnerRequest{Id: "s-lead0000001", RepoSlugs: []string{"o/r"}, Number: 7}, &v1.SendThreadMessageRequest{ThreadId: "s-lead0000001"}},
			wantPrompt: "Follow-up task: fix the failing checks on PR `o/r#7`",
			wantMsg:    "Sent to s-lead0000001",
			wantJSON:   command.PRTaskResult{ThreadID: "s-lead0000001", Sent: true}},
		{name: "thread: forwarded to the thread that owns the link, noted in the sender, which is woken once",
			args: args("o/r", "checks", "thread", "s-lead0000001"),
			uctx: command.Context{ActiveView: "thread", ActiveThreadID: "s-lead0000001"},
			setup: func(f *prThreadFixture) {
				f.thread.Others = []*v1.Thread{{Id: "s-lead0000001", Name: "Lead"}, {Id: "s-kid00000001", Name: "Kid"}}
				f.thread.Owners, f.thread.SentOrdinal = map[string]string{"s-lead0000001": "s-kid00000001"}, 4
			},
			wantReq: []proto.Message{detail("o/r", true)},
			wantThread: []proto.Message{
				&v1.GetThreadRequest{Id: "s-lead0000001"},
				&v1.PullRequestOwnerRequest{Id: "s-lead0000001", RepoSlugs: []string{"o/r"}, Number: 7},
				&v1.GetThreadRequest{Id: "s-kid00000001"},
				&v1.SubscribeThreadRequest{SubscriberThreadId: "s-lead0000001", TargetThreadId: "s-kid00000001", BeforeSend: true,
					Condition: v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED,
					Note:      "pr.task forwarded from you: Fix the failing checks on o/r#7"},
				&v1.SendThreadMessageRequest{ThreadId: "s-kid00000001"},
				&v1.SubscribeThreadRequest{SubscriberThreadId: "s-lead0000001", TargetThreadId: "s-kid00000001", AfterOrdinal: 4,
					Condition: v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED,
					Note:      "pr.task forwarded from you: Fix the failing checks on o/r#7"},
				&v1.AddThreadNoteRequest{ThreadId: "s-lead0000001", Text: "Sent to Kid (s-kid00000001): Fix the failing checks (#7)"},
				&v1.ListThreadSubscriptionsRequest{SubscriberThreadId: "s-lead0000001"},
			},
			wantPrompt:   "Follow-up task: fix the failing checks on PR `o/r#7`",
			wantInPrompt: []string{"\nThe user sent this task from thread `Lead (s-lead0000001)`, which has this PR through you; it is woken with your last message"},
			wantMsg:      "Sent to Kid (s-kid00000001) for Lead (s-lead0000001) (#4); wait with: code-foundry thread wait s-kid00000001 --after 4",
			wantJSON:     command.PRTaskResult{ThreadID: "s-kid00000001", ViaThreadID: "s-lead0000001", Sent: true, Ordinal: 4}},
		{name: "thread: forwarded from an agent's CLI, the message is the caller's and says so",
			args: args("o/r", "review-request", "thread", "s-lead0000001"),
			uctx: command.Context{ActiveThreadID: "s-ember000001"},
			setup: func(f *prThreadFixture) {
				f.thread.Owners, f.thread.SentOrdinal = map[string]string{"s-lead0000001": "s-kid00000001"}, 6
			},
			wantReq: []proto.Message{detail("o/r", false)},
			wantThread: []proto.Message{
				&v1.GetThreadRequest{Id: "s-lead0000001"},
				&v1.PullRequestOwnerRequest{Id: "s-lead0000001", RepoSlugs: []string{"o/r"}, Number: 7},
				&v1.GetThreadRequest{Id: "s-kid00000001"},
				&v1.SubscribeThreadRequest{SubscriberThreadId: "s-lead0000001", TargetThreadId: "s-kid00000001", BeforeSend: true,
					Condition: v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED,
					Note:      "pr.task forwarded from you: Review it (read-only) on o/r#7"},
				&v1.SendThreadMessageRequest{ThreadId: "s-kid00000001", ByThreadId: "s-ember000001"},
				&v1.SubscribeThreadRequest{SubscriberThreadId: "s-lead0000001", TargetThreadId: "s-kid00000001", AfterOrdinal: 6,
					Condition: v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED,
					Note:      "pr.task forwarded from you: Review it (read-only) on o/r#7"},
				&v1.AddThreadNoteRequest{ThreadId: "s-lead0000001", Text: "Sent to s-kid00000001: Review it (read-only) (#7)"},
				&v1.ListThreadSubscriptionsRequest{SubscriberThreadId: "s-ember000001"},
			},
			wantPrompt:   "Follow-up task: review PR `o/r#7`",
			wantInPrompt: []string{"\nThis task was sent from thread `s-lead0000001`"},
			wantMsg:      "Sent to s-kid00000001 for s-lead0000001 (#6); wait with: code-foundry thread wait s-kid00000001 --after 6",
			wantJSON:     command.PRTaskResult{ThreadID: "s-kid00000001", ViaThreadID: "s-lead0000001", Sent: true, Ordinal: 6}},
		{name: "thread: a send that answers no ordinal: nothing to wait for, the subscription made for it is dropped, the note and the message say no wake comes",
			args: args("o/r", "checks", "thread", "s-lead0000001"),
			setup: func(f *prThreadFixture) {
				f.thread.Owners = map[string]string{"s-lead0000001": "s-kid00000001"}
			},
			wantReq: []proto.Message{detail("o/r", true)},
			wantThread: []proto.Message{
				&v1.GetThreadRequest{Id: "s-lead0000001"},
				&v1.PullRequestOwnerRequest{Id: "s-lead0000001", RepoSlugs: []string{"o/r"}, Number: 7},
				&v1.GetThreadRequest{Id: "s-kid00000001"},
				&v1.SubscribeThreadRequest{SubscriberThreadId: "s-lead0000001", TargetThreadId: "s-kid00000001", BeforeSend: true,
					Condition: v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED,
					Note:      "pr.task forwarded from you: Fix the failing checks on o/r#7"},
				&v1.SendThreadMessageRequest{ThreadId: "s-kid00000001"},
				&v1.UnsubscribeThreadRequest{SubscriptionId: "sub-1"},
				&v1.AddThreadNoteRequest{ThreadId: "s-lead0000001", Text: "Sent to s-kid00000001: Fix the failing checks (#7); it will not wake this thread: the send did not say which message to wait for"},
			},
			wantPrompt: "Follow-up task: fix the failing checks on PR `o/r#7`",
			wantMsg:    "Sent to s-kid00000001 for s-lead0000001; s-lead0000001 will not be woken: the send did not say which message to wait for",
			wantJSON:   command.PRTaskResult{ThreadID: "s-kid00000001", ViaThreadID: "s-lead0000001", Sent: true}},
		{name: "thread: an owner that cannot be read: the task goes to the thread itself",
			args: args("o/r", "checks", "thread", "s-lead0000001"),
			setup: func(f *prThreadFixture) {
				f.thread.Owners = map[string]string{"s-lead0000001": "s-kid00000001"}
				f.thread.GetErrs = map[string]error{"s-kid00000001": connect.NewError(connect.CodeNotFound, errors.New("no thread"))}
			},
			wantReq: []proto.Message{detail("o/r", true)},
			wantThread: []proto.Message{
				&v1.GetThreadRequest{Id: "s-lead0000001"},
				&v1.PullRequestOwnerRequest{Id: "s-lead0000001", RepoSlugs: []string{"o/r"}, Number: 7},
				&v1.GetThreadRequest{Id: "s-kid00000001"},
				&v1.SendThreadMessageRequest{ThreadId: "s-lead0000001"},
			},
			wantPrompt: "Follow-up task: fix the failing checks on PR `o/r#7`",
			wantMsg:    "Sent to s-lead0000001",
			wantJSON:   command.PRTaskResult{ThreadID: "s-lead0000001", Sent: true}},
		{name: "thread: an owner removed before the send: the task goes to the thread itself, no note, the wake made for it dropped",
			args: args("o/r", "checks", "thread", "s-lead0000001"),
			setup: func(f *prThreadFixture) {
				f.thread.Owners = map[string]string{"s-lead0000001": "s-kid00000001"}
				f.thread.SendErrs = map[string]error{"s-kid00000001": removedErr(t, &v1.RemovedThread{Id: "s-kid00000001"})}
			},
			wantReq: []proto.Message{detail("o/r", true)},
			wantThread: []proto.Message{
				&v1.GetThreadRequest{Id: "s-lead0000001"},
				&v1.PullRequestOwnerRequest{Id: "s-lead0000001", RepoSlugs: []string{"o/r"}, Number: 7},
				&v1.GetThreadRequest{Id: "s-kid00000001"},
				&v1.SubscribeThreadRequest{SubscriberThreadId: "s-lead0000001", TargetThreadId: "s-kid00000001", BeforeSend: true,
					Condition: v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED,
					Note:      "pr.task forwarded from you: Fix the failing checks on o/r#7"},
				&v1.SendThreadMessageRequest{ThreadId: "s-kid00000001"},
				&v1.UnsubscribeThreadRequest{SubscriptionId: "sub-1"},
				&v1.SendThreadMessageRequest{ThreadId: "s-lead0000001"},
			},
			wantPrompt: "Follow-up task: fix the failing checks on PR `o/r#7`",
			wantMsg:    "Sent to s-lead0000001",
			wantJSON:   command.PRTaskResult{ThreadID: "s-lead0000001", Sent: true}},
		{name: "thread: an owner removed before the send, the sender already subscribed to it: its subscription stays",
			args: args("o/r", "checks", "thread", "s-lead0000001"),
			setup: func(f *prThreadFixture) {
				f.thread.Owners, f.thread.Existed = map[string]string{"s-lead0000001": "s-kid00000001"}, true
				f.thread.SendErrs = map[string]error{"s-kid00000001": removedErr(t, &v1.RemovedThread{Id: "s-kid00000001"})}
			},
			wantReq: []proto.Message{detail("o/r", true)},
			wantThread: []proto.Message{
				&v1.GetThreadRequest{Id: "s-lead0000001"},
				&v1.PullRequestOwnerRequest{Id: "s-lead0000001", RepoSlugs: []string{"o/r"}, Number: 7},
				&v1.GetThreadRequest{Id: "s-kid00000001"},
				&v1.SubscribeThreadRequest{SubscriberThreadId: "s-lead0000001", TargetThreadId: "s-kid00000001", BeforeSend: true,
					Condition: v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED,
					Note:      "pr.task forwarded from you: Fix the failing checks on o/r#7"},
				&v1.SendThreadMessageRequest{ThreadId: "s-kid00000001"},
				&v1.SendThreadMessageRequest{ThreadId: "s-lead0000001"},
			},
			wantPrompt: "Follow-up task: fix the failing checks on PR `o/r#7`",
			wantMsg:    "Sent to s-lead0000001",
			wantJSON:   command.PRTaskResult{ThreadID: "s-lead0000001", Sent: true}},
		{name: "thread: a sender that cannot be woken (archived): the prompt promises no wake, the note and the message say why",
			args: args("o/r", "checks", "thread", "s-lead0000001"),
			uctx: command.Context{ActiveView: "thread", ActiveThreadID: "s-lead0000001"},
			setup: func(f *prThreadFixture) {
				f.thread.Others = []*v1.Thread{{Id: "s-lead0000001", Name: "Lead"}, {Id: "s-kid00000001", Name: "Kid"}}
				f.thread.Owners, f.thread.SentOrdinal = map[string]string{"s-lead0000001": "s-kid00000001"}, 4
				f.thread.SubscribeErr = connect.NewError(connect.CodeFailedPrecondition, errors.New("failed precondition: thread s-lead0000001 is archived; unarchive it to subscribe it"))
			},
			wantReq: []proto.Message{detail("o/r", true)},
			wantThread: []proto.Message{
				&v1.GetThreadRequest{Id: "s-lead0000001"},
				&v1.PullRequestOwnerRequest{Id: "s-lead0000001", RepoSlugs: []string{"o/r"}, Number: 7},
				&v1.GetThreadRequest{Id: "s-kid00000001"},
				&v1.SubscribeThreadRequest{SubscriberThreadId: "s-lead0000001", TargetThreadId: "s-kid00000001", BeforeSend: true,
					Condition: v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED,
					Note:      "pr.task forwarded from you: Fix the failing checks on o/r#7"},
				&v1.SendThreadMessageRequest{ThreadId: "s-kid00000001"},
				&v1.AddThreadNoteRequest{ThreadId: "s-lead0000001", Text: "Sent to Kid (s-kid00000001): Fix the failing checks (#7); it will not wake this thread: thread s-lead0000001 is archived; unarchive it to subscribe it"},
				&v1.ListThreadSubscriptionsRequest{SubscriberThreadId: "s-lead0000001"},
			},
			wantPrompt:      "Follow-up task: fix the failing checks on PR `o/r#7`",
			wantInPrompt:    []string{"\nThe user sent this task from thread `Lead (s-lead0000001)`, which has this PR through you.\n"},
			wantNotInPrompt: []string{"woken", "thread report"},
			wantMsg:         "Sent to Kid (s-kid00000001) for Lead (s-lead0000001) (#4); wait with: code-foundry thread wait s-kid00000001 --after 4; Lead (s-lead0000001) will not be woken: thread s-lead0000001 is archived; unarchive it to subscribe it",
			wantJSON:        command.PRTaskResult{ThreadID: "s-kid00000001", ViaThreadID: "s-lead0000001", Sent: true, Ordinal: 4}},
		{name: "thread: arming the wake fails after the send: the subscription made for it is dropped, the note and the message say no wake comes",
			args: args("o/r", "checks", "thread", "s-lead0000001"),
			setup: func(f *prThreadFixture) {
				f.thread.Owners, f.thread.SentOrdinal = map[string]string{"s-lead0000001": "s-kid00000001"}, 4
				f.thread.SubscribeErrAfter = connect.NewError(connect.CodeFailedPrecondition, errors.New("thread s-lead0000001 is archived"))
			},
			wantReq: []proto.Message{detail("o/r", true)},
			wantThread: []proto.Message{
				&v1.GetThreadRequest{Id: "s-lead0000001"},
				&v1.PullRequestOwnerRequest{Id: "s-lead0000001", RepoSlugs: []string{"o/r"}, Number: 7},
				&v1.GetThreadRequest{Id: "s-kid00000001"},
				&v1.SubscribeThreadRequest{SubscriberThreadId: "s-lead0000001", TargetThreadId: "s-kid00000001", BeforeSend: true,
					Condition: v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED,
					Note:      "pr.task forwarded from you: Fix the failing checks on o/r#7"},
				&v1.SendThreadMessageRequest{ThreadId: "s-kid00000001"},
				&v1.SubscribeThreadRequest{SubscriberThreadId: "s-lead0000001", TargetThreadId: "s-kid00000001", AfterOrdinal: 4,
					Condition: v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED,
					Note:      "pr.task forwarded from you: Fix the failing checks on o/r#7"},
				&v1.UnsubscribeThreadRequest{SubscriptionId: "sub-1"},
				&v1.AddThreadNoteRequest{ThreadId: "s-lead0000001", Text: "Sent to s-kid00000001: Fix the failing checks (#7); it will not wake this thread: thread s-lead0000001 is archived"},
			},
			wantPrompt:   "Follow-up task: fix the failing checks on PR `o/r#7`",
			wantInPrompt: []string{"it is woken with your last message"},
			wantMsg:      "Sent to s-kid00000001 for s-lead0000001 (#4); wait with: code-foundry thread wait s-kid00000001 --after 4; s-lead0000001 will not be woken: thread s-lead0000001 is archived",
			wantJSON:     command.PRTaskResult{ThreadID: "s-kid00000001", ViaThreadID: "s-lead0000001", Sent: true, Ordinal: 4}},
		{name: "thread: a renamed repository's link is looked up under both names",
			args: args("o/old", "checks", "thread", "s-lead0000001"),
			setup: func(f *prThreadFixture) {
				f.gh.Detail.PullRequest.RepoSlug = "o/r"
			},
			wantThread: []proto.Message{
				&v1.GetThreadRequest{Id: "s-lead0000001"},
				&v1.PullRequestOwnerRequest{Id: "s-lead0000001", RepoSlugs: []string{"o/old", "o/r"}, Number: 7},
				&v1.SendThreadMessageRequest{ThreadId: "s-lead0000001"},
			},
			wantPrompt: "Follow-up task: fix the failing checks on PR `o/r#7`",
			wantMsg:    "Sent to s-lead0000001",
			wantJSON:   command.PRTaskResult{ThreadID: "s-lead0000001", Sent: true}},
		{name: "thread: an unknown thread keeps its code and sends nothing",
			args: args("o/r", "checks", "thread", "s-gone"),
			setup: func(f *prThreadFixture) {
				f.thread.Err = connect.NewError(connect.CodeNotFound, errors.New("no thread s-gone"))
			},
			wantReq:    []proto.Message{detail("o/r", true)},
			wantThread: []proto.Message{&v1.GetThreadRequest{Id: "s-gone"}},
			wantCode:   connect.CodeNotFound, wantErrMsg: "find thread s-gone: no thread s-gone"},
		{name: "thread: a removed thread says so and exits 1, as thread.send",
			args: args("o/r", "checks", "thread", "s-gone0000001"),
			setup: func(f *prThreadFixture) {
				f.thread.Err = removedErr(t, &v1.RemovedThread{Id: "s-gone0000001", Name: "Gone"})
			},
			wantReq:    []proto.Message{detail("o/r", true)},
			wantThread: []proto.Message{&v1.GetThreadRequest{Id: "s-gone0000001"}},
			wantMsg:    "thread Gone (s-gone0000001) was removed\nno report\ncost: $0.00",
			wantExit:   1},
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
		{name: "worktree and thread together, refused before the read", args: args("o/r", "checks", "thread", "s-lead0000001", "worktree", "/wt/topic"),
			wantReq: []proto.Message{}, wantErr: command.ErrInvalidArgs, wantErrMsg: "worktree is for a new thread"},
		{name: "model and thread together", args: args("o/r", "checks", "thread", "s-lead0000001", "model", "claude-4.5-haiku[1m]"),
			wantReq: []proto.Message{}, wantErr: command.ErrInvalidArgs, wantErrMsg: "model is for a new thread"},
		{name: "effort and thread together", args: args("o/r", "checks", "thread", "s-lead0000001", "effort", "low"),
			wantReq: []proto.Message{}, wantErr: command.ErrInvalidArgs, wantErrMsg: "effort is for a new thread"},
		{name: "focus and thread together", args: args("o/r", "review-request", "thread", "s-lead0000001", "focus", "false"),
			wantReq: []proto.Message{}, wantErr: command.ErrInvalidArgs, wantErrMsg: "focus is for a new thread"},
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
					for _, not := range tt.wantNotInPrompt {
						if strings.Contains(prompt, not) {
							t.Errorf("prompt = %q, want it without %q", prompt, not)
						}
					}
				}
				if !proto.Equal(req, tt.wantThread[i]) {
					t.Errorf("thread request %d = %v, want %v", i, req, tt.wantThread[i])
				}
			}
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) || !strings.Contains(err.Error(), tt.wantErrMsg) {
					t.Fatalf("err = %v, want %v containing %q", err, tt.wantErr, tt.wantErrMsg)
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
			if res.ExitCode != tt.wantExit {
				t.Errorf("exit code = %d, want %d", res.ExitCode, tt.wantExit)
			}
			if tt.wantExit != 0 {
				return
			}
			if got, ok := res.JSON.(command.PRTaskResult); !ok || got != tt.wantJSON {
				t.Errorf("JSON = %#v, want %#v", res.JSON, tt.wantJSON)
			}
		})
	}
}

// removedErr is the NOT_FOUND error the thread service answers a removed thread with.
func removedErr(t *testing.T, r *v1.RemovedThread) error {
	t.Helper()
	err := connect.NewError(connect.CodeNotFound, errors.New("thread "+r.GetId()+" was removed"))
	d, derr := connect.NewErrorDetail(r)
	if derr != nil {
		t.Fatal(derr)
	}
	err.AddDetail(d)
	return err
}
