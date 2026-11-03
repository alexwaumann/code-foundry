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
	// push: the task changes the branch and pushes it (placement prThreadFix: a fork's
	// head must already be checked out somewhere); otherwise it only reads
	// (prThreadReview). Push tasks also refresh the detail first.
	push bool
}

// prTasks are pr.task's kinds by name; PRTaskKinds lists them in help order.
var prTasks = map[string]prTask{
	"checks":         {prompt: ChecksPRTaskPrompt, push: true},
	"review":         {prompt: ReviewPRTaskPrompt, push: true},
	"conversations":  {prompt: ConversationsPRTaskPrompt, push: true},
	"conflicts":      {prompt: ConflictsPRTaskPrompt, push: true},
	"behind":         {prompt: BehindPRTaskPrompt, push: true},
	"review-request": {prompt: ReviewRequestPRTaskPrompt},
}

// PRTaskKinds are pr.task's kind values.
var PRTaskKinds = []string{"checks", "review", "conversations", "conflicts", "behind", "review-request"}

// PRTaskResult is pr.task's result JSON.
type PRTaskResult struct {
	// ThreadID is the thread the task went to: the --thread one, or the new one.
	ThreadID string `json:"threadId"`
	// Sent: the task went into an existing thread as a message; false when a thread was
	// started for it.
	Sent bool `json:"sent"`
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
				Description: "Send the task into this thread (as thread.send: mid-turn while it works) instead of starting one" + IDHelp},
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
			s, n := strings.TrimSpace(a.String("repo-slug")), a.Int("number")
			detail, err := d.readPR(ctx, s, n, task.push)
			if err != nil {
				return Result{}, err
			}
			if id := a.String("thread"); id != "" {
				if a.Given("worktree") {
					return Result{}, InvalidArg("worktree", "worktree is where a new thread starts; with thread the task goes into that thread")
				}
				return d.sendPRTask(ctx, uctx, id, n, task, detail)
			}
			return d.startPRTask(ctx, a, s, n, task, detail)
		},
	}
}

// sendPRTask sends the task into thread id as a follow-up message. The window keeps its
// selection.
func (d PullRequestThreadDeps) sendPRTask(ctx context.Context, uctx Context, id string, n int, task prTask, detail *v1.PullRequestDetail) (Result, error) {
	prompt := task.prompt(detail, PRTaskOptions{FollowUp: true})
	if err := checkPRPromptSize(n, prompt); err != nil {
		return Result{}, err
	}
	got, err := d.Thread.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: id}))
	if err != nil {
		return Result{}, wrapStep("find thread "+id, err)
	}
	th := got.Msg.GetThread()
	// From a thread's CLI the message is that thread's, as thread.send's --by: the
	// user's prompt history leaves it out.
	var by string
	if uctx.ActiveView == "" {
		by = uctx.CallerThreadID
	}
	if _, err := d.Thread.Send(ctx, connect.NewRequest(&v1.SendThreadMessageRequest{ThreadId: th.GetId(), Text: prompt, ByThreadId: by})); err != nil {
		return Result{}, wrapStep("send to thread "+threadLabel(th), err)
	}
	return Result{Message: "Sent to " + threadLabel(th), JSON: PRTaskResult{ThreadID: th.GetId(), Sent: true}}, nil
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
	var cloned bool
	if explicit == "" && len(clonesOf(projects, s)) == 0 {
		// Refuse what a fresh clone could not place (a fork's head to push to, no head
		// branch) before cloning: the clone would not help.
		if _, err := pickPRWorktree(kind, []*v1.Project{{GithubSlug: s}}, s, n, head, "", ""); err != nil {
			return Result{}, err
		}
		p, err := d.Clone(ctx, s, nil)
		if err != nil {
			return Result{}, wrapStep("clone "+s, err)
		}
		if p.GetGithubSlug() == "" {
			p = proto.CloneOf(p)
			p.GithubSlug = s
		}
		projects, cloned = []*v1.Project{p}, true
	}
	pick, err := pickPRWorktree(kind, projects, s, n, head, explicit, "")
	if err != nil {
		return Result{}, err
	}
	if explicit != "" {
		// A review there reads off the head unless the worktree is known to be on it.
		wt := registeredWorktree(projects, pick.Path)
		pick.OffHead = wt == nil || !head.checkedOutIn(wt)
	}
	status := worktreeStatus(projects, pick.Path)
	if pick.Create {
		wt, err := createPRWorktree(ctx, d, pick, s, head)
		if err != nil {
			return Result{}, err
		}
		pick.ProjectID, pick.Path, status = cmp.Or(wt.GetProjectId(), pick.ProjectID), wt.GetPath(), wt.GetStatus()
	}
	created, err := d.Thread.Create(ctx, connect.NewRequest(&v1.CreateThreadRequest{
		ProjectId: pick.ProjectID, WorktreePath: pick.Path, Model: a.String("model"), Effort: a.String("effort"),
		InitialPrompt: task.prompt(detail, PRTaskOptions{Checkout: prCheckoutOf(status), OffHead: pick.OffHead}),
	}))
	if err != nil {
		return Result{}, wrapStep("start thread", err)
	}
	th := created.Msg.GetThread()
	focusCreated(d.Emitter, a, th.GetId())
	msg := fmt.Sprintf("Started thread %s for PR #%d", threadLabel(th), n)
	if cloned {
		msg = fmt.Sprintf("Cloned %s and started thread %s for PR #%d", s, threadLabel(th), n)
	}
	return Result{Message: msg, JSON: PRTaskResult{
		ThreadID: th.GetId(), ProjectID: th.GetProjectId(), WorktreePath: th.GetWorktreePath(),
		CreatedWorktree: pick.Create, Cloned: cloned,
	}}, nil
}
