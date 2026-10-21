package threadtest

import (
	"cmp"
	"context"
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Wake subscriptions in the fake: kept in memory, validated like the store (one target,
// the condition, self and the reverse of an existing one refused, the note), never
// fired. Fired is set when a thread target already meets the condition, as the store
// would. Every change publishes thread.SubscriptionsChanged, as the store does.

// Subscribe records "Subscribe <subscriber> <kind> <target> <condition> repeat=<bool>"
// (and " args=k=v,…" for a plugin target) and keeps the subscription as "sub-<n>". A run
// target is accepted whatever its id, a plugin target with the args as given; a pull
// request is normalised (thread.ParsePullRequestTarget) and never fires.
func (f *Fake) Subscribe(_ context.Context, o thread.SubscribeOptions) (thread.SubscribeResult, error) {
	kind, target, cond := thread.TargetThread, strings.TrimSpace(o.TargetThreadID), cmp.Or(o.Condition, thread.CondSettled)
	if run := strings.TrimSpace(o.TargetRunID); run != "" {
		kind, target, cond = thread.TargetActionRun, run, thread.CondFinished
	}
	if pr := strings.TrimSpace(o.TargetPullRequest); pr != "" {
		kind, cond = thread.TargetPullRequest, cmp.Or(o.Condition, thread.CondChecksDone)
		var err error
		if target, err = thread.ParsePullRequestTarget(pr); err != nil {
			return thread.SubscribeResult{}, err
		}
	}
	call := fmt.Sprintf("Subscribe %s %s %s %s repeat=%t", o.SubscriberID, kind, target, cond, o.Repeat)
	if plugin := strings.TrimSpace(o.TargetPlugin); plugin != "" {
		kind, target, cond = thread.TargetPlugin, plugin, thread.CondFired
		call = fmt.Sprintf("Subscribe %s %s %s %s repeat=%t args=%s", o.SubscriberID, kind, target, cond, o.Repeat, formatArgs(o.Args))
	}
	timer := !o.TargetAt.IsZero() || o.TargetEvery != 0
	if timer {
		var err error
		if target, cond, err = thread.TimerTarget(o.TargetAt, o.TargetEvery, o.Condition); err != nil {
			return thread.SubscribeResult{}, err
		}
		kind = thread.TargetTimer
		o.Repeat = o.TargetEvery > 0
		call = fmt.Sprintf("Subscribe %s %s %s %s repeat=%t", o.SubscriberID, kind, target, cond, o.Repeat)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record(call); err != nil {
		return thread.SubscribeResult{}, err
	}
	targets := 0
	for _, t := range []string{o.TargetThreadID, o.TargetRunID, o.TargetPullRequest, o.TargetPlugin} {
		if strings.TrimSpace(t) != "" {
			targets++
		}
	}
	if timer {
		targets++
	}
	switch {
	case targets != 1:
		return thread.SubscribeResult{}, fmt.Errorf("%w: give exactly one target", thread.ErrInvalidArgument)
	case kind == thread.TargetThread && !slices.Contains(thread.ThreadConditions, cond),
		kind == thread.TargetPullRequest && !slices.Contains(thread.PullRequestConditions, cond):
		return thread.SubscribeResult{}, fmt.Errorf("%w: condition %q", thread.ErrInvalidArgument, cond)
	}
	if _, err := f.get(o.SubscriberID); err != nil {
		return thread.SubscribeResult{}, err
	}
	note, err := thread.CleanNote(o.Note)
	if err != nil {
		return thread.SubscribeResult{}, err
	}
	fired := false
	if kind == thread.TargetThread {
		t, err := f.get(target)
		if err != nil {
			return thread.SubscribeResult{}, err
		}
		if target == o.SubscriberID {
			return thread.SubscribeResult{}, fmt.Errorf("%w: thread %s cannot subscribe to itself", thread.ErrFailedPrecondition, target)
		}
		for _, s := range f.subs {
			if s.SubscriberID == target && s.TargetID == o.SubscriberID {
				return thread.SubscribeResult{}, fmt.Errorf("%w: thread %s already subscribes to thread %s", thread.ErrFailedPrecondition, target, o.SubscriberID)
			}
		}
		fired = thread.Meets(cond, t)
	}
	f.nextSub++
	sub := thread.Subscription{
		ID: fmt.Sprintf("sub-%d", f.nextSub), SubscriberID: o.SubscriberID, TargetKind: kind, TargetID: target, Condition: cond,
		Repeat: o.Repeat && kind != thread.TargetActionRun, Note: note, CreatedAt: f.Now(), Args: maps.Clone(o.Args),
	}
	if fired {
		sub.FiredCount, sub.LastFiredAt = 1, sub.CreatedAt
	}
	if !fired || sub.Repeat {
		f.subs = append(f.subs, sub)
		bus.Publish(f.bus, thread.SubscriptionsChanged{SubscriberID: sub.SubscriberID})
	}
	return thread.SubscribeResult{Subscription: sub, Fired: fired}, nil
}

// Unsubscribe records "Unsubscribe <id>" or "Unsubscribe <subscriber> <target>"
// ("timer" for every timer).
func (f *Fake) Unsubscribe(_ context.Context, o thread.UnsubscribeOptions) ([]thread.Subscription, error) {
	target := o.TargetThreadID + o.TargetRunID + o.TargetPlugin
	if o.TargetTimer {
		target = "timer"
	}
	if o.TargetPullRequest != "" {
		target, _ = thread.ParsePullRequestTarget(o.TargetPullRequest)
	}
	call := "Unsubscribe " + o.ID
	if o.ID == "" {
		call = "Unsubscribe " + o.SubscriberID + " " + target
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record(call); err != nil {
		return nil, err
	}
	var out []thread.Subscription
	f.subs = slices.DeleteFunc(f.subs, func(s thread.Subscription) bool {
		hit := (o.ID != "" && s.ID == o.ID) || (o.ID == "" && s.SubscriberID == o.SubscriberID &&
			(s.TargetID == target || (o.TargetTimer && s.TargetKind == thread.TargetTimer)))
		if hit {
			out = append(out, s)
		}
		return hit
	})
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: no such subscription", thread.ErrNotFound)
	}
	for _, s := range out {
		bus.Publish(f.bus, thread.SubscriptionsChanged{SubscriberID: s.SubscriberID})
	}
	return out, nil
}

// Subscriptions records "Subscriptions <subscriber>" and returns the subscriber's (all
// for ""), with the names and statuses of the fake's threads.
func (f *Fake) Subscriptions(_ context.Context, subscriber string) ([]thread.Subscription, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record("Subscriptions " + subscriber); err != nil {
		return nil, err
	}
	var out []thread.Subscription
	for _, s := range f.subs {
		if subscriber != "" && s.SubscriberID != subscriber {
			continue
		}
		if t, ok := f.byID[s.SubscriberID]; ok {
			s.SubscriberName = t.Name
		}
		s.TargetStatus = "gone"
		switch s.TargetKind {
		case thread.TargetPlugin:
			s.TargetName, s.TargetStatus = s.TargetID, "running"
		case thread.TargetTimer:
			thread.DescribeTimer(&s, f.Now()) // NextAt and Every
			s.TargetName, s.TargetStatus = strings.Replace(s.TargetID, ":", " ", 1), "next"
		}
		if t, ok := f.byID[s.TargetID]; ok {
			s.TargetName, s.TargetStatus = t.Name, t.Status.String()
		}
		out = append(out, s)
	}
	return out, nil
}

// PutSubscription adds a subscription as it is (tests of listings and loop guards).
func (f *Fake) PutSubscription(s thread.Subscription) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.subs = append(f.subs, s)
	bus.Publish(f.bus, thread.SubscriptionsChanged{SubscriberID: s.SubscriberID})
}

// formatArgs is a plugin target's args as "k=v,…", sorted ("-" for none).
func formatArgs(args map[string]string) string {
	if len(args) == 0 {
		return "-"
	}
	var parts []string
	for _, k := range slices.Sorted(maps.Keys(args)) {
		parts = append(parts, k+"="+args[k])
	}
	return strings.Join(parts, ",")
}
