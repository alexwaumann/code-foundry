package command

import (
	"context"
	"fmt"
	"log/slog"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// pr.task's forward (docs/notes/pr-task-forward.md). The pull request panel offers the
// user's own threads as targets (sidebar threads and Ember's), and a parent links every
// pull request its created threads link. A task sent to such a thread T goes to the
// thread whose own link it is (the owner, ThreadService.PullRequestOwner): the owner
// gets the task with a line saying it came from T; T gets a note in its conversation
// (no turn) and one wake when the owner next settles, with the owner's report.

// PullRequestTaskBackend is what pr.task's forward needs beyond the conversation:
// the owner of a thread's link, and the note in the sender's conversation.
type PullRequestTaskBackend interface {
	PullRequestOwner(context.Context, *connect.Request[v1.PullRequestOwnerRequest]) (*connect.Response[v1.PullRequestOwnerResponse], error)
	AddNote(context.Context, *connect.Request[v1.AddThreadNoteRequest]) (*connect.Response[v1.AddThreadNoteResponse], error)
}

var _ PullRequestTaskBackend = codefoundryv1connect.ThreadServiceHandler(nil)

// prTaskOwner is the thread that owns th's link to the pull request when it is not th
// itself, nil otherwise: th's own link or none, or an owner that cannot be read (gone
// since, or an error, logged), in which case th gets the task and can delegate.
func (d PullRequestThreadDeps) prTaskOwner(ctx context.Context, th *v1.Thread, slugs []string, n int) *v1.Thread {
	res, err := d.Thread.PullRequestOwner(ctx, connect.NewRequest(&v1.PullRequestOwnerRequest{Id: th.GetId(), RepoSlugs: slugs, Number: int32(n)}))
	if err != nil {
		slog.Warn("pr.task: find the thread that owns the link; sending to the thread itself", "thread", th.GetId(), "pr", n, "err", err)
		return nil
	}
	id := res.Msg.GetOwnerThreadId()
	if id == "" || id == th.GetId() {
		return nil
	}
	got, err := d.Thread.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: id}))
	if err != nil {
		slog.Info("pr.task: the thread that owns the link is gone; sending to the thread itself", "thread", th.GetId(), "owner", id, "err", err)
		return nil
	}
	return got.Msg.GetThread()
}

// forwardPRTask sends the task into owner for th, then notes it in th and subscribes
// th to owner's next settle. sent is false (and nothing happened) when owner was removed
// since it was read: the caller sends to th instead. The note and the wake are best
// effort: the task went out, so their failure is logged, not returned.
func (d PullRequestThreadDeps) forwardPRTask(ctx context.Context, uctx Context, th, owner *v1.Thread, n int, task prTask, detail *v1.PullRequestDetail) (Result, bool, error) {
	prompt := task.prompt(detail, PRTaskOptions{FollowUp: true, ForwardedFrom: threadLabel(th), ForwardedByUser: uctx.ActiveView != ""})
	if err := checkPRPromptSize(n, prompt); err != nil {
		return Result{}, false, err
	}
	ordinal, removed, err := d.sendPRTaskTo(ctx, uctx, owner, prompt)
	switch {
	case removed != nil:
		return Result{}, false, nil
	case err != nil:
		return Result{}, false, err
	}
	if _, err := d.Thread.AddNote(ctx, connect.NewRequest(&v1.AddThreadNoteRequest{ThreadId: th.GetId(), Text: forwardNote(owner, task, n)})); err != nil {
		slog.Warn("pr.task: note the forward in the sending thread", "thread", th.GetId(), "owner", owner.GetId(), "err", err)
	}
	if _, err := d.Thread.Subscribe(ctx, connect.NewRequest(&v1.SubscribeThreadRequest{
		SubscriberThreadId: th.GetId(), TargetThreadId: owner.GetId(), Next: true,
		Condition: v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED,
		Note:      forwardWakeNote(task, detail, n),
	})); err != nil {
		slog.Warn("pr.task: wake the sending thread when the owner settles", "thread", th.GetId(), "owner", owner.GetId(), "err", err)
	}
	return d.sentPRTask(ctx, uctx, owner, th, ordinal), true, nil
}

// forwardNote is the sender's note: "Sent to <owner>: <task> (#N)".
func forwardNote(owner *v1.Thread, task prTask, n int) string {
	return fmt.Sprintf("Sent to %s: %s (#%d)", threadLabel(owner), task.title, n)
}

// forwardWakeNote is the sender's subscription note, which its wake carries: the task
// and the pull request (within MaxNote).
func forwardWakeNote(task prTask, detail *v1.PullRequestDetail, n int) string {
	return fmt.Sprintf("pr.task forwarded from you: %s on %s#%d", task.title, sanitizePRCode(detail.GetPullRequest().GetRepoSlug()), n)
}
