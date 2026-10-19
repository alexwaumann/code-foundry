package command

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Wake subscriptions (docs/notes/agents-4-wake.md, docs/notes/gh-events-3-pr-wake.md):
// thread.subscribe has the daemon send a thread (default: the one this runs in) a wake
// message when another thread settles (or is idle, needs attention, has an error, is
// disconnected), an action run finishes, or a pull request's checks finish, it gets a
// review or comment, is pushed, merged or closed, so an agent that started other
// threads or opened a pull request is woken instead of polling.
// thread.unsubscribe and thread.subscriptions manage them. thread.new --notify
// subscribes the creator to the new thread (commands_thread_lifecycle.go).

// SubscriptionBackend is the slice of ThreadService the subscription commands need.
type SubscriptionBackend interface {
	Subscribe(context.Context, *connect.Request[v1.SubscribeThreadRequest]) (*connect.Response[v1.SubscribeThreadResponse], error)
	Unsubscribe(context.Context, *connect.Request[v1.UnsubscribeThreadRequest]) (*connect.Response[v1.UnsubscribeThreadResponse], error)
	ListSubscriptions(context.Context, *connect.Request[v1.ListThreadSubscriptionsRequest]) (*connect.Response[v1.ListThreadSubscriptionsResponse], error)
}

// SubscriptionConditions are thread.subscribe's until values: a thread takes settled to
// disconnected, a run only finished (settled means finished for a run), a pull request
// checks_done to changed.
var SubscriptionConditions = append([]string{"settled", "idle", "attention", "error", "disconnected", "finished"}, pullRequestConditions...)

// pullRequestConditions are the conditions of a pull request target; the first is the
// default.
var pullRequestConditions = []string{"checks_done", "checks_failed", "checks_passed", "review", "comment",
	"review_requested", "head_pushed", "merged", "closed", "changed"}

var subscriptionConditions = map[string]v1.ThreadSubscriptionCondition{
	"settled":      v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED,
	"idle":         v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_IDLE,
	"attention":    v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ATTENTION,
	"error":        v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ERROR,
	"disconnected": v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_DISCONNECTED,
	"finished":     v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FINISHED,

	"checks_done":      v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHECKS_DONE,
	"checks_failed":    v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHECKS_FAILED,
	"checks_passed":    v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHECKS_PASSED,
	"review":           v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_REVIEW,
	"comment":          v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_COMMENT,
	"review_requested": v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_REVIEW_REQUESTED,
	"head_pushed":      v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_HEAD_PUSHED,
	"merged":           v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_MERGED,
	"closed":           v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CLOSED,
	"changed":          v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHANGED,
}

// pullRequestVerbs say what a pull request does to meet a condition.
var pullRequestVerbs = map[v1.ThreadSubscriptionCondition]string{
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHECKS_DONE:      "finishes its checks",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHECKS_FAILED:    "fails its checks",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHECKS_PASSED:    "passes its checks",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_REVIEW:           "gets a review",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_COMMENT:          "gets a comment",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_REVIEW_REQUESTED: "gets a review request",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_HEAD_PUSHED:      "is pushed",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_MERGED:           "is merged",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CLOSED:           "is closed",
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHANGED:          "changes",
}

// conditionName is a condition as thread.subscribe spells it.
func conditionName(c v1.ThreadSubscriptionCondition) string {
	for name, v := range subscriptionConditions {
		if v == c {
			return name
		}
	}
	return "settled"
}

// subscriptionTarget is "thread s-1", "run r-1" or "pr acme/web#7".
func subscriptionTarget(s *v1.ThreadSubscription) string {
	switch s.GetTarget() {
	case v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_ACTION_RUN:
		return "run " + s.GetTargetId()
	case v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_PULL_REQUEST:
		return "pr " + s.GetTargetId()
	}
	return "thread " + s.GetTargetId()
}

// subscriptionLine is one subscription in a message: "sub-1: s-p wakes when thread s-c
// is settled (repeat)".
func subscriptionLine(s *v1.ThreadSubscription) string {
	how := "once"
	if s.GetRepeat() {
		how = "repeat"
	}
	verb := "is " + conditionName(s.GetCondition())
	switch s.GetCondition() {
	case v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ATTENTION:
		verb = "needs attention"
	case v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ERROR:
		verb = "has an error"
	case v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FINISHED:
		verb = "finishes"
	}
	if v, ok := pullRequestVerbs[s.GetCondition()]; ok {
		verb = v
	}
	return s.GetId() + ": " + s.GetSubscriberThreadId() + " wakes when " + subscriptionTarget(s) + " " + verb + " (" + how + ")"
}

// subscribeTargetArgs reads exactly one of thread, run and pr.
func subscribeTargetArgs(a Args) (thread, run, pr string, err error) {
	thread, run, pr = strings.TrimSpace(a.String("thread")), strings.TrimSpace(a.String("run")), strings.TrimSpace(a.String("pr"))
	n := 0
	for _, t := range []string{thread, run, pr} {
		if t != "" {
			n++
		}
	}
	if n != 1 {
		return "", "", "", InvalidArg("thread", "give exactly one target: thread (a thread id), run (an action run id) or pr (owner/name#123 or a pull request URL)")
	}
	return thread, run, pr, nil
}

func threadSubscribe(b ThreadBackend) Command {
	return Command{
		Name:  "thread.subscribe",
		Title: "Subscribe Thread to Wakes",
		Description: "Wake a thread (default: the thread this runs in) with a message when another thread settles, " +
			"an action run finishes, or a pull request's checks finish. " +
			"Fires on each change into the condition, and at once when already met; once by default, every time with repeat.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "id", Type: String, Required: true, Context: ContextThread, ID: ThreadID, Description: "The thread to wake (default: the thread this runs in)" + IDHelp},
			{Name: "thread", Type: String, ID: ThreadID, Description: "Target thread id" + IDHelp},
			{Name: "run", Type: String, ID: RunID, Description: "Target action run id (r-…; see action runs)" + IDHelp},
			{Name: "pr", Type: String, Description: "Target pull request: owner/name#123 or its URL"},
			{Name: "until", Type: Enum, Enum: SubscriptionConditions,
				Description: "Default: settled for a thread, finished for a run, checks_done for a pull request"},
			{Name: "repeat", Type: Bool, Description: "Wake on every change into the condition, not once"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			thread, run, pr, err := subscribeTargetArgs(a)
			if err != nil {
				return Result{}, err
			}
			until := a.String("until")
			isPR := slices.Contains(pullRequestConditions, until)
			switch {
			case run != "" && until != "" && until != "settled" && until != "finished":
				return Result{}, InvalidArg("until", "an action run's only condition is finished, not %s", until)
			case thread != "" && (until == "finished" || isPR):
				return Result{}, InvalidArg("until", "%s is not a thread's condition; a thread takes settled, idle, attention, error or disconnected", until)
			case pr != "" && until != "" && !isPR:
				return Result{}, InvalidArg("until", "%s is not a pull request's condition; a pull request takes %s", until, strings.Join(pullRequestConditions, ", "))
			}
			res, err := b.Subscribe(ctx, connect.NewRequest(&v1.SubscribeThreadRequest{
				SubscriberThreadId: a.String("id"), TargetThreadId: thread, TargetRunId: run, TargetPullRequest: pr,
				Condition: subscriptionConditions[until], Repeat: a.Bool("repeat"),
			}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetSubscription()
			msg := "subscribed " + subscriptionLine(s)
			switch {
			case res.Msg.GetExisted():
				msg = "already subscribed " + subscriptionLine(s)
			case res.Msg.GetFired() && !s.GetRepeat():
				msg = "woke " + s.GetSubscriberThreadId() + " at once: " + subscriptionTarget(s) + " already met the condition (" +
					conditionName(s.GetCondition()) + "); the one-shot subscription " + s.GetId() + " is done"
			case res.Msg.GetFired():
				msg += "; woke it at once: the target already met the condition"
			}
			return Result{Message: msg, JSON: res.Msg}, nil
		},
	}
}

func threadUnsubscribe(b ThreadBackend) Command {
	return Command{
		Name:  "thread.unsubscribe",
		Title: "Unsubscribe Thread from Wakes",
		Description: "Remove a wake subscription by id, or every subscription of a thread (default: the thread this runs in) " +
			"to a target.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "subscription", Type: String, Positional: true, ID: SubscriptionID, Description: "Subscription id (sub-…)" + IDHelp},
			{Name: "id", Type: String, Context: ContextThread, ID: ThreadID, Description: "With a target: the subscribed thread (default: the thread this runs in)" + IDHelp},
			{Name: "thread", Type: String, ID: ThreadID, Description: "Remove the subscriptions to this thread" + IDHelp},
			{Name: "run", Type: String, ID: RunID, Description: "Remove the subscriptions to this action run" + IDHelp},
			{Name: "pr", Type: String, Description: "Remove the subscriptions to this pull request"},
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			req := &v1.UnsubscribeThreadRequest{SubscriptionId: strings.TrimSpace(a.String("subscription"))}
			if req.SubscriptionId == "" {
				thread, run, pr, err := subscribeTargetArgs(a)
				if err != nil {
					return Result{}, InvalidArg("subscription", "give a subscription id, or a target (thread, run or pr)")
				}
				if a.String("id") == "" {
					return Result{}, InvalidArg("id", "give the subscribed thread's id with a target")
				}
				req.SubscriberThreadId, req.TargetThreadId, req.TargetRunId, req.TargetPullRequest = a.String("id"), thread, run, pr
			} else if a.String("thread") != "" || a.String("run") != "" || a.String("pr") != "" {
				return Result{}, InvalidArg("subscription", "give a subscription id or a target, not both")
			}
			res, err := b.Unsubscribe(ctx, connect.NewRequest(req))
			if err != nil {
				return Result{}, err
			}
			var lines []string
			for _, s := range res.Msg.GetRemoved() {
				lines = append(lines, "removed "+subscriptionLine(s))
			}
			return Result{Message: strings.Join(lines, "\n"), JSON: res.Msg}, nil
		},
	}
}

func threadSubscriptions(b ThreadBackend) Command {
	return Command{
		Name:  "thread.subscriptions",
		Title: "List Thread Wake Subscriptions",
		Description: "List a thread's wake subscriptions (default: the thread this runs in; all for every thread) " +
			"with their targets' status and how often they fired.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "id", Type: String, Context: ContextThread, ID: ThreadID, Description: "Subscribed thread id (default: the thread this runs in)" + IDHelp},
			{Name: "all", Type: Bool, Description: "Every thread's subscriptions"},
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			id := a.String("id")
			if a.Bool("all") {
				id = ""
			} else if id == "" {
				return Result{}, InvalidArg("id", "give a thread id, or all")
			}
			res, err := b.ListSubscriptions(ctx, connect.NewRequest(&v1.ListThreadSubscriptionsRequest{SubscriberThreadId: id}))
			if err != nil {
				return Result{}, err
			}
			return Result{Message: formatSubscriptions(res.Msg.GetSubscriptions(), id), JSON: res.Msg}, nil
		},
	}
}

// formatSubscriptions is thread.subscriptions' table.
func formatSubscriptions(subs []*v1.ThreadSubscription, subscriber string) string {
	if len(subs) == 0 {
		if subscriber != "" {
			return "thread " + subscriber + " has no wake subscriptions"
		}
		return "no wake subscriptions"
	}
	named := func(id, name string) string {
		if name != "" {
			return id + " (" + name + ")"
		}
		return id
	}
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "ID\tSUBSCRIBER\tTARGET\tUNTIL\tREPEAT\tFIRED\tLAST FIRED\tTARGET STATUS")
	for _, s := range subs {
		repeat, last := "no", "-"
		if s.GetRepeat() {
			repeat = "yes"
		}
		if t := s.GetLastFiredAt(); t != nil {
			last = t.AsTime().Local().Format(time.TimeOnly)
		}
		target := strings.SplitN(subscriptionTarget(s), " ", 2)[0] + " " + named(s.GetTargetId(), s.GetTargetName())
		if s.GetTarget() == v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_PULL_REQUEST {
			target = "pr " + cmp.Or(s.GetTargetName(), s.GetTargetId()) // the name starts with the id
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", s.GetId(), named(s.GetSubscriberThreadId(), s.GetSubscriberName()),
			target,
			conditionName(s.GetCondition()), repeat, strconv.FormatInt(s.GetFiredCount(), 10), last, s.GetTargetStatus())
	}
	_ = tw.Flush()
	return strings.TrimRight(sb.String(), "\n")
}
