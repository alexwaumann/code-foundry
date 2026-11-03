package command

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

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

// forwardPRTask sends the task into owner for th, then notes it in th. th is subscribed,
// one-shot, to owner settling from the task before the send, so the prompt and the note
// promise a wake only when there will be one (an archived th, or a subscription that
// would wake the two in a loop, is refused: the prompt then says nothing of a wake, and
// the note and the message say why). After the send the subscription is armed with the
// message's ordinal: it fires once a turn of owner's that took the message in ended
// (SubscribeThreadRequest.after_ordinal). sent is false (and nothing is left behind)
// when owner was removed since it was read: the caller sends to th instead. The note and
// the arming are best effort: the task went out, so their failure is logged, not
// returned.
func (d PullRequestThreadDeps) forwardPRTask(ctx context.Context, uctx Context, th, owner *v1.Thread, n int, task prTask, detail *v1.PullRequestDetail) (Result, bool, error) {
	opts := PRTaskOptions{FollowUp: true, ForwardedFrom: threadLabel(th), ForwardedByUser: uctx.ActiveView != ""}
	// The prompt that promises the wake is the longer one: it bounds both.
	if err := checkPRPromptSize(n, task.prompt(detail, opts)); err != nil {
		return Result{}, false, err
	}
	note := forwardWakeNote(task, detail, n)
	wake := v1.SubscribeThreadRequest{SubscriberThreadId: th.GetId(), TargetThreadId: owner.GetId(),
		Condition: v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED, Note: note}
	before := proto.CloneOf(&wake)
	before.BeforeSend = true
	var made string // the subscription made for this forward ("" when one existed)
	noWake := ""
	if res, err := d.Thread.Subscribe(ctx, connect.NewRequest(before)); err != nil {
		noWake = errMessage(err)
		slog.Info("pr.task: the sending thread cannot be woken by the forward's owner", "thread", th.GetId(), "owner", owner.GetId(), "err", err)
	} else if !res.Msg.GetExisted() {
		made = res.Msg.GetSubscription().GetId()
	}
	opts.ForwardedNoWake = noWake != ""
	ordinal, removed, err := d.sendPRTaskTo(ctx, uctx, owner, task.prompt(detail, opts))
	if removed != nil || err != nil {
		d.dropForwardWake(ctx, th, made)
		if removed != nil {
			return Result{}, false, nil
		}
		return Result{}, false, err
	}
	if noWake == "" {
		// The prompt went out promising the wake: when it cannot be armed, the note and
		// the message say it will not come.
		if ordinal <= 0 {
			// Nothing to wait for: arming on another message would wake on the wrong turn.
			slog.Warn("pr.task: the send answered no message ordinal; the sending thread is not woken", "thread", th.GetId(), "owner", owner.GetId())
			d.dropForwardWake(ctx, th, made)
			noWake = "the send did not say which message to wait for"
		} else {
			armed := proto.CloneOf(&wake)
			armed.AfterOrdinal = ordinal
			if _, err := d.Thread.Subscribe(ctx, connect.NewRequest(armed)); err != nil {
				slog.Warn("pr.task: arm the sending thread's wake on the owner", "thread", th.GetId(), "owner", owner.GetId(), "err", err)
				d.dropForwardWake(ctx, th, made)
				noWake = errMessage(err)
			}
		}
	}
	if _, err := d.Thread.AddNote(ctx, connect.NewRequest(&v1.AddThreadNoteRequest{ThreadId: th.GetId(), Text: forwardNote(owner, task, n, noWake)})); err != nil {
		slog.Warn("pr.task: note the forward in the sending thread", "thread", th.GetId(), "owner", owner.GetId(), "err", err)
	}
	res := d.sentPRTask(ctx, uctx, owner, th, ordinal)
	if noWake != "" {
		res.Message += "; " + threadLabel(th) + " will not be woken: " + noWake
	}
	return res, true, nil
}

// dropForwardWake removes the subscription a forward made before a send that did not
// happen (id "" for none).
func (d PullRequestThreadDeps) dropForwardWake(ctx context.Context, th *v1.Thread, id string) {
	if id == "" {
		return
	}
	if _, err := d.Thread.Unsubscribe(ctx, connect.NewRequest(&v1.UnsubscribeThreadRequest{SubscriptionId: id})); err != nil {
		slog.Warn("pr.task: drop the forward's wake", "thread", th.GetId(), "subscription", id, "err", err)
	}
}

// errMessage is err's message without its code (a connect error's, and the store's
// "failed precondition: " in front), for a line a person reads.
func errMessage(err error) string {
	var ce *connect.Error
	if !errors.As(err, &ce) {
		return err.Error()
	}
	return strings.TrimPrefix(ce.Message(), strings.ReplaceAll(ce.Code().String(), "_", " ")+": ")
}

// forwardNote is the sender's note: "Sent to <owner>: <task> (#N)", and why it will not
// be woken when it will not (noWake).
func forwardNote(owner *v1.Thread, task prTask, n int, noWake string) string {
	out := fmt.Sprintf("Sent to %s: %s (#%d)", threadLabel(owner), task.title, n)
	if noWake != "" {
		out += "; it will not wake this thread: " + noWake
	}
	return out
}

// forwardWakeNote is the sender's subscription note, which its wake carries: the task
// and the pull request (within MaxNote).
func forwardWakeNote(task prTask, detail *v1.PullRequestDetail, n int) string {
	return fmt.Sprintf("pr.task forwarded from you: %s on %s#%d", task.title, sanitizePRCode(detail.GetPullRequest().GetRepoSlug()), n)
}
