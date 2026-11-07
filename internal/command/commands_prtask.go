package command

import (
	"cmp"
	"context"
	"fmt"
	"math"
	"strings"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// pr.task: the pull request panel's "have the thread handle it" actions
// (docs/notes/pr-tasks.md). It reads the pull request, builds the prompt for the task
// kind (prtaskprompt.go), and either sends it into an existing thread (--thread, as
// thread.send: mid-turn when the thread works) or starts a thread for it in the
// worktree on the pull request's head branch, cloning the repository first when no
// project is a clone of it.

// prTask is one pr.task kind.
type prTask struct {
	prompt func(*v1.PullRequestDetail, PRTaskOptions) string
	// title is the task in a few words, for a forward's note and wake ("Fix the
	// failing checks").
	title string
	// push: the task changes the branch and pushes it (placement prThreadFix: a fork's
	// head must already be checked out somewhere); otherwise it only reads
	// (prThreadReview). Push tasks also refresh the detail first.
	push bool
}

// prTasks are pr.task's kinds by name; PRTaskKinds lists them in help order.
var prTasks = map[string]prTask{
	"checks":         {prompt: ChecksPRTaskPrompt, title: "Fix the failing checks", push: true},
	"review":         {prompt: ReviewPRTaskPrompt, title: "Address the requested changes", push: true},
	"conversations":  {prompt: ConversationsPRTaskPrompt, title: "Address the unresolved conversations", push: true},
	"conflicts":      {prompt: ConflictsPRTaskPrompt, title: "Resolve the conflicts", push: true},
	"behind":         {prompt: BehindPRTaskPrompt, title: "Bring the branch up to date", push: true},
	"review-request": {prompt: ReviewRequestPRTaskPrompt, title: "Review it (read-only)"},
}

// PRTaskKinds are pr.task's kind values.
var PRTaskKinds = []string{"checks", "review", "conversations", "conflicts", "behind", "review-request"}

// PRTaskResult is pr.task's result JSON.
type PRTaskResult struct {
	// ThreadID is the thread the task went to: the --thread one (or the thread its link
	// to the pull request came through, ViaThreadID), or the new one.
	ThreadID string `json:"threadId"`
	// ViaThreadID is the --thread thread when the task was forwarded from it to the
	// thread that owns its link to the pull request (ThreadID; docs/notes/pr-task-forward.md).
	ViaThreadID string `json:"viaThreadId,omitempty"`
	// Sent: the task went into an existing thread as a message; false when a thread was
	// started for it.
	Sent bool `json:"sent"`
	// Ordinal is the sent message's item ordinal (thread wait --after takes it); 0 when
	// a thread was started.
	Ordinal int64 `json:"ordinal,omitempty"`
	// ProjectID and WorktreePath are where a new thread runs (empty when Sent).
	ProjectID    string `json:"projectId,omitempty"`
	WorktreePath string `json:"worktreePath,omitempty"`
	// CreatedWorktree: a worktree was created on the head branch for the new thread.
	CreatedWorktree bool `json:"createdWorktree,omitempty"`
	// Cloned: no project was a clone of the repository, so it was cloned first.
	Cloned bool `json:"cloned,omitempty"`
}

// prTaskCommand is pr.task, registered with the other pull request thread commands.
func prTaskCommand(d PullRequestThreadDeps, slug, number, worktree, model, effort ArgSpec) Command {
	return Command{
		Name:      "pr.task",
		Page:      PageDrives,
		NoPalette: true,
		Title:     "Hand Pull Request Task to Thread",
		Description: "Have a thread handle one of a pull request's open items: fix failing checks, address requested changes " +
			"or unresolved conversations, resolve conflicts, bring the branch up to date, or review someone's pull request (read-only). " +
			"With thread it is sent into that thread like thread.send; otherwise a thread starts in the worktree on the pull request's " +
			"branch (created if needed), cloning the repository as a project first when none is, or in the given worktree.",
		Category: "Pull Request",
		Args: []ArgSpec{slug, number,
			{Name: "kind", Type: Enum, Enum: PRTaskKinds, Required: true, Positional: true,
				Description: "checks, review (requested changes), conversations (unresolved review threads), conflicts, behind (update with the base), or review-request (review it, read-only)"},
			{Name: "thread", Type: String, ID: ThreadID,
				Description: "Send the task into this thread (as thread.send: mid-turn while it works) instead of starting one. " +
					"When its link to the pull request came from a thread it created, the task goes to that thread instead, " +
					"and this one gets a note and one wake when that thread settles" + IDHelp},
			worktree, model, effort, createdFocusArg,
		},
		When: hasPullRequest,
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			if err := checkPullRequestArgs(a); err != nil {
				return Result{}, err
			}
			task, ok := prTasks[a.String("kind")]
			if !ok {
				return Result{}, InvalidArg("kind", "kind must be one of %s", strings.Join(PRTaskKinds, ", "))
			}
			id := a.String("thread")
			if err := checkPRTaskArgs(a, id != ""); err != nil {
				return Result{}, err
			}
			s, n := strings.TrimSpace(a.String("repo-slug")), a.Int("number")
			detail, err := d.readPR(ctx, s, n, task.push)
			if err != nil {
				return Result{}, err
			}
			if id != "" {
				return d.sendPRTask(ctx, uctx, id, prTaskSlugs(s, detail.GetPullRequest().GetRepoSlug()), n, task, detail)
			}
			return d.startPRTask(ctx, a, s, n, task, detail)
		},
	}
}

// prTaskNewThreadArgs are pr.task's args that only a new thread uses.
var prTaskNewThreadArgs = []string{"worktree", "model", "effort", "focus"}

// checkPRTaskArgs refuses, before anything is read, an arg that only a new thread uses
// given together with thread: it would be ignored.
func checkPRTaskArgs(a Args, toThread bool) error {
	if !toThread {
		return nil
	}
	for _, name := range prTaskNewThreadArgs {
		if a.Given(name) {
			return InvalidArg(name, "%s is for a new thread; with thread the task goes into that thread as it is", name)
		}
	}
	return nil
}

// sendPRTask sends the task into thread id as a follow-up message, or, when id's link
// to the pull request (number, any of slugs) came through a thread it created, into the
// thread that owns the link (forwardPRTask). The window keeps its selection.
func (d PullRequestThreadDeps) sendPRTask(ctx context.Context, uctx Context, id string, slugs []string, n int, task prTask, detail *v1.PullRequestDetail) (Result, error) {
	prompt := task.prompt(detail, PRTaskOptions{FollowUp: true})
	if err := checkPRPromptSize(n, prompt); err != nil {
		return Result{}, err
	}
	got, err := d.Thread.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: id}))
	if r, ok := removedFrom(err); ok {
		return removedWaitResult(r, ""), nil // exit 1, as thread.send
	}
	if err != nil {
		return Result{}, wrapStep("find thread "+id, err)
	}
	th := got.Msg.GetThread()
	if owner := d.prTaskOwner(ctx, th, slugs, n); owner != nil {
		if res, sent, err := d.forwardPRTask(ctx, uctx, th, owner, n, task, detail); sent || err != nil {
			return res, err
		}
		// The owner was removed since: the task goes to th, which can delegate.
	}
	ordinal, removed, err := d.sendPRTaskTo(ctx, uctx, th, prompt)
	if removed != nil {
		return removedWaitResult(removed, ""), nil // removed since the Get
	}
	if err != nil {
		return Result{}, err
	}
	return d.sentPRTask(ctx, uctx, th, nil, ordinal), nil
}

// prTaskSlugs are the names a thread's link to the pull request may have: the argument
// and GitHub's current one (a renamed repository), once each, case aside.
func prTaskSlugs(arg, canon string) []string {
	if canon == "" || strings.EqualFold(arg, canon) {
		return []string{arg}
	}
	return []string{arg, canon}
}

// prTaskBy is the sending thread of a pr.task message: from a thread's CLI the message
// is that thread's, as thread.send's --by (the user's prompt history leaves it out);
// from the GUI it is the user's own.
func prTaskBy(uctx Context) string {
	if uctx.ActiveView == "" {
		return uctx.CallerThreadID
	}
	return ""
}

// sendPRTaskTo sends prompt into th, as thread.send, and returns the message's ordinal;
// removed when th was removed since it was read.
func (d PullRequestThreadDeps) sendPRTaskTo(ctx context.Context, uctx Context, th *v1.Thread, prompt string) (int64, *v1.RemovedThread, error) {
	res, err := d.Thread.Send(ctx, connect.NewRequest(&v1.SendThreadMessageRequest{ThreadId: th.GetId(), Text: prompt, ByThreadId: prTaskBy(uctx)}))
	if r, ok := removedFrom(err); ok {
		return 0, r, nil
	}
	if err != nil {
		return 0, nil, wrapStep("send to thread "+threadLabel(th), err)
	}
	return res.Msg.GetItem().GetOrdinal(), nil, nil
}

// sentPRTask is pr.task's answer for a task sent into th as its message ordinal, from
// via when it was forwarded (nil otherwise): "Sent to <th> [for <via>] (#N); <next>",
// next as thread.send's.
func (d PullRequestThreadDeps) sentPRTask(ctx context.Context, uctx Context, th, via *v1.Thread, ordinal int64) Result {
	msg := "Sent to " + threadLabel(th)
	out := PRTaskResult{ThreadID: th.GetId(), Sent: true, Ordinal: ordinal}
	if via != nil {
		msg += " for " + threadLabel(via)
		out.ViaThreadID = via.GetId()
	}
	if ordinal > 0 {
		msg += fmt.Sprintf(" (#%d); %s", ordinal, sendNext(ctx, d.Thread, uctx.CallerThreadID, th.GetId(), ordinal))
	}
	return Result{Message: msg, JSON: out}
}

// startPRTask starts a thread for the task (routing rules 3 and 4 of the pull request
// panel): in the worktree on the pull request's head branch, reused or created, after
// cloning the repository as a project when none is a clone of it. A push task on a
// fork's pull request needs a worktree with its head checked out (as pr.fix.findings);
// a review-request without one runs off the head in the main worktree. An explicit
// worktree is used as is (nothing is cloned or created).
func (d PullRequestThreadDeps) startPRTask(ctx context.Context, a Args, s string, n int, task prTask, detail *v1.PullRequestDetail) (Result, error) {
	// The worst-case checkout bounds the prompt, whatever the worktree turns out to be.
	worst := PRCheckout{Behind: math.MaxInt32, Dirty: true}
	for _, off := range []bool{false, true} {
		if err := checkPRPromptSize(n, task.prompt(detail, PRTaskOptions{Checkout: worst, OffHead: off})); err != nil {
			return Result{}, err
		}
	}
	kind := prThreadReview
	if task.push {
		kind = prThreadFix
	}
	head := prHeadOf(detail.GetPullRequest())
	explicit := a.Path("worktree")
	var projects []*v1.Project
	switch list, err := d.Project.List(ctx, connect.NewRequest(&v1.ListProjectsRequest{})); {
	case err == nil:
		projects = list.Msg.GetProjects()
	case explicit == "":
		return Result{}, wrapStep("list projects", err)
	} // An explicit worktree only loses its status line in the prompt.
	// Clones match the argument or GitHub's current name for the repository (renamed or
	// transferred since the argument was taken).
	match := s
	if canon := detail.GetPullRequest().GetRepoSlug(); len(clonesOf(projects, s)) == 0 && len(clonesOf(projects, canon)) > 0 {
		match = canon
	}
	var (
		cloned   bool
		clonedAt string
	)
	if explicit == "" && len(clonesOf(projects, match)) == 0 {
		canon := detail.GetPullRequest().GetRepoSlug()
		// A project whose origin names the repository but is not recognised as GitHub
		// (an SSH host alias) is most likely a clone: refuse rather than clone it again.
		if err := unrecognisedClone(projects, s, canon); err != nil {
			return Result{}, err
		}
		// Refuse what a fresh clone could not place (a fork's head to push to, no head
		// branch) before cloning: the clone would not help.
		if err := uncloneablePRTask(task, canon, n, head); err != nil {
			return Result{}, err
		}
		p, err := d.Clone(ctx, canon, nil)
		if err != nil {
			return Result{}, wrapStep("clone "+canon, err)
		}
		if p.GetGithubSlug() == "" {
			p = proto.CloneOf(p)
			p.GithubSlug = canon
		}
		projects, cloned, match = []*v1.Project{p}, true, p.GetGithubSlug()
		clonedAt = cmp.Or(p.GetPath(), "the projects folder")
	}
	// A step that fails after a clone says the clone stays a project: a retry finds it.
	afterClone := func(err error) error {
		if !cloned {
			return err
		}
		return wrapStep(fmt.Sprintf("cloned %s into %s, which stays a project", match, clonedAt), err)
	}
	pick, err := pickPRWorktree(kind, projects, match, n, head, explicit, "")
	if err != nil {
		return Result{}, afterClone(err)
	}
	if explicit != "" {
		// A review there reads off the head unless the worktree is known to be on it.
		wt := registeredWorktree(projects, pick.Path)
		pick.OffHead = wt == nil || !head.checkedOutIn(wt)
	}
	status := worktreeStatus(projects, pick.Path)
	if pick.Create {
		wt, err := createPRWorktree(ctx, d, pick, match, head)
		if err != nil {
			return Result{}, afterClone(err)
		}
		pick.ProjectID, pick.Path, status = cmp.Or(wt.GetProjectId(), pick.ProjectID), wt.GetPath(), wt.GetStatus()
	}
	created, err := d.Thread.Create(ctx, connect.NewRequest(&v1.CreateThreadRequest{
		ProjectId: pick.ProjectID, WorktreePath: pick.Path, Model: a.String("model"), Effort: a.String("effort"),
		InitialPrompt: task.prompt(detail, PRTaskOptions{Checkout: prCheckoutOf(status), OffHead: pick.OffHead}),
	}))
	if err != nil {
		return Result{}, afterClone(wrapStep("start thread", err))
	}
	th := created.Msg.GetThread()
	focusCreated(d.Emitter, a, th.GetId())
	msg := fmt.Sprintf("Started thread %s for PR #%d", threadLabel(th), n)
	if cloned {
		msg = fmt.Sprintf("Cloned %s and started thread %s for PR #%d", match, threadLabel(th), n)
	}
	return Result{Message: msg, JSON: PRTaskResult{
		ThreadID: th.GetId(), ProjectID: th.GetProjectId(), WorktreePath: th.GetWorktreePath(),
		CreatedWorktree: pick.Create, Cloned: cloned,
	}}, nil
}

// unrecognisedClone refuses (FailedPrecondition) when a project's origin path names one
// of slugs, ending in /<owner>/<repo> (case-insensitively, with or without .git), though
// its github_slug does not: an origin on an SSH host alias (git@github-work:org/repo.git)
// or another host. Cloning would make a second copy of what is most likely a clone.
func unrecognisedClone(projects []*v1.Project, slugs ...string) error {
	for _, p := range projects {
		for _, slug := range slugs {
			if !originNames(p.GetOriginPath(), slug) {
				continue
			}
			return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf(
				"project %s looks like a clone of %s (its origin is …/%s) but its origin is not a github.com URL, so it is not used and no second clone is made: "+
					"pass --worktree with one of its worktrees, or point its origin at github.com (`git remote set-url origin git@github.com:%s.git`)",
				cmp.Or(p.GetName(), p.GetPath()), slug, strings.TrimLeft(p.GetOriginPath(), "/"), slug))
		}
	}
	return nil
}

// originNames reports whether origin, a remote URL's path, names the repository slug:
// it is <owner>/<repo> or ends in /<owner>/<repo>, case-insensitively, with or without
// a trailing .git or slash.
func originNames(origin, slug string) bool {
	o := strings.TrimSuffix(strings.Trim(strings.ToLower(origin), "/"), ".git")
	slug = strings.ToLower(strings.TrimSpace(slug))
	if o == "" || strings.Count(slug, "/") != 1 {
		return false
	}
	return o == slug || strings.HasSuffix(o, "/"+slug)
}

// uncloneablePRTask refuses (FailedPrecondition), before slug is cloned as a project, a
// push task that a fresh clone could not place either: no head branch, or a fork's head
// (a new clone has no worktree with it checked out). A review-request always fits.
func uncloneablePRTask(task prTask, slug string, n int, head prHead) error {
	switch {
	case !task.push:
		return nil
	case head.Ref == "":
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("#%d has no head branch to check out: pass --worktree", n))
	case head.Cross:
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf(
			"#%d comes from a fork and %s is not a project yet: clone it (`code-foundry project clone %s`), check out the head in a worktree there (`gh pr checkout %d`), and pass --worktree",
			n, slug, slug, n))
	}
	return nil
}
