package command

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Wake subscriptions (docs/notes/agents-4-wake.md): thread.subscribe has the daemon
// send a thread (default: the one this runs in) a wake message when another thread
// settles (or is idle, needs attention, has an error, is disconnected) or an action run
// finishes, so an agent that started other threads is woken instead of polling.
// thread.unsubscribe and thread.subscriptions manage them. thread.new --notify
// subscribes the creator to the new thread (commands_thread_lifecycle.go).

// SubscriptionBackend is the slice of ThreadService the subscription commands need.
type SubscriptionBackend interface {
	Subscribe(context.Context, *connect.Request[v1.SubscribeThreadRequest]) (*connect.Response[v1.SubscribeThreadResponse], error)
	Unsubscribe(context.Context, *connect.Request[v1.UnsubscribeThreadRequest]) (*connect.Response[v1.UnsubscribeThreadResponse], error)
	ListSubscriptions(context.Context, *connect.Request[v1.ListThreadSubscriptionsRequest]) (*connect.Response[v1.ListThreadSubscriptionsResponse], error)
}

// SubscriptionConditions are thread.subscribe's until values: a thread takes every one
// but finished, a run only finished (settled, the default, means finished for a run).
var SubscriptionConditions = []string{"settled", "idle", "attention", "error", "disconnected", "finished"}

var subscriptionConditions = map[string]v1.ThreadSubscriptionCondition{
	"settled":      v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED,
	"idle":         v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_IDLE,
	"attention":    v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ATTENTION,
	"error":        v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ERROR,
	"disconnected": v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_DISCONNECTED,
	"finished":     v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FINISHED,
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

// subscriptionTarget is "thread s-1" or "run r-1".
func subscriptionTarget(s *v1.ThreadSubscription) string {
	if s.GetTarget() == v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_ACTION_RUN {
		return "run " + s.GetTargetId()
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
	return s.GetId() + ": " + s.GetSubscriberThreadId() + " wakes when " + subscriptionTarget(s) + " " + verb + " (" + how + ")"
}

// subscribeTargetArgs reads exactly one of thread and run.
func subscribeTargetArgs(a Args) (thread, run string, err error) {
	thread, run = strings.TrimSpace(a.String("thread")), strings.TrimSpace(a.String("run"))
	if (thread == "") == (run == "") {
		return "", "", InvalidArg("thread", "give exactly one target: thread (a thread id) or run (an action run id)")
	}
	return thread, run, nil
}

func threadSubscribe(b ThreadBackend) Command {
	return Command{
		Name:  "thread.subscribe",
		Title: "Subscribe Thread to Wakes",
		Description: "Wake a thread (default: the thread this runs in) with a message when another thread settles " +
			"(or is idle, needs attention, has an error, is disconnected) or an action run finishes. " +
			"Fires on each change into the condition, and at once when the target already meets it; " +
			"once by default, every time with repeat. A stopped thread starts with the wake; a snoozed one is unsnoozed.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "id", Type: String, Required: true, Context: ContextThread, Description: "The thread to wake (default: the thread this runs in)"},
			{Name: "thread", Type: String, Description: "Target thread id"},
			{Name: "run", Type: String, Description: "Target action run id (r-…; see action runs)"},
			{Name: "until", Type: Enum, Enum: SubscriptionConditions, Default: "settled",
				Description: "settled (idle or needs attention: Claude is not working), idle, attention, error or disconnected; a run: finished"},
			{Name: "repeat", Type: Bool, Description: "Wake on every change into the condition (default: once, then the subscription goes)"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			thread, run, err := subscribeTargetArgs(a)
			if err != nil {
				return Result{}, err
			}
			until := a.String("until")
			switch {
			case run != "" && until != "settled" && until != "finished":
				return Result{}, InvalidArg("until", "an action run's only condition is finished, not %s", until)
			case thread != "" && until == "finished":
				return Result{}, InvalidArg("until", "finished is an action run's condition; a thread takes settled, idle, attention, error or disconnected")
			}
			res, err := b.Subscribe(ctx, connect.NewRequest(&v1.SubscribeThreadRequest{
				SubscriberThreadId: a.String("id"), TargetThreadId: thread, TargetRunId: run,
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
			"to a target thread or action run.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "subscription", Type: String, Positional: true, Description: "Subscription id (sub-…)"},
			{Name: "id", Type: String, Context: ContextThread, Description: "With thread or run: the subscribed thread (default: the thread this runs in)"},
			{Name: "thread", Type: String, Description: "Remove the subscriptions to this thread"},
			{Name: "run", Type: String, Description: "Remove the subscriptions to this action run"},
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			req := &v1.UnsubscribeThreadRequest{SubscriptionId: strings.TrimSpace(a.String("subscription"))}
			if req.SubscriptionId == "" {
				thread, run, err := subscribeTargetArgs(a)
				if err != nil {
					return Result{}, InvalidArg("subscription", "give a subscription id, or a target (thread or run)")
				}
				if a.String("id") == "" {
					return Result{}, InvalidArg("id", "give the subscribed thread's id with a target")
				}
				req.SubscriberThreadId, req.TargetThreadId, req.TargetRunId = a.String("id"), thread, run
			} else if a.String("thread") != "" || a.String("run") != "" {
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
			{Name: "id", Type: String, Context: ContextThread, Description: "Subscribed thread id (default: the thread this runs in)"},
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
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", s.GetId(), named(s.GetSubscriberThreadId(), s.GetSubscriberName()),
			strings.SplitN(subscriptionTarget(s), " ", 2)[0]+" "+named(s.GetTargetId(), s.GetTargetName()),
			conditionName(s.GetCondition()), repeat, strconv.FormatInt(s.GetFiredCount(), 10), last, s.GetTargetStatus())
	}
	_ = tw.Flush()
	return strings.TrimRight(sb.String(), "\n")
}
