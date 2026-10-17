package threadtest

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Wake subscriptions in the fake: kept in memory, validated like the store (one target,
// the condition, self and the reverse of an existing one refused), never fired. Fired
// is set when a thread target already meets the condition, as the store would.

// Subscribe records "Subscribe <subscriber> <kind> <target> <condition> repeat=<bool>"
// and keeps the subscription as "sub-<n>". A run target is accepted whatever its id.
func (f *Fake) Subscribe(_ context.Context, o thread.SubscribeOptions) (thread.SubscribeResult, error) {
	kind, target, cond := thread.TargetThread, strings.TrimSpace(o.TargetThreadID), cmp.Or(o.Condition, thread.CondSettled)
	if run := strings.TrimSpace(o.TargetRunID); run != "" {
		kind, target, cond = thread.TargetActionRun, run, thread.CondFinished
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record(fmt.Sprintf("Subscribe %s %s %s %s repeat=%t", o.SubscriberID, kind, target, cond, o.Repeat)); err != nil {
		return thread.SubscribeResult{}, err
	}
	switch {
	case (o.TargetThreadID == "") == (o.TargetRunID == ""):
		return thread.SubscribeResult{}, fmt.Errorf("%w: give exactly one target", thread.ErrInvalidArgument)
	case kind == thread.TargetThread && !slices.Contains(thread.ThreadConditions, cond):
		return thread.SubscribeResult{}, fmt.Errorf("%w: condition %q", thread.ErrInvalidArgument, cond)
	}
	if _, err := f.get(o.SubscriberID); err != nil {
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
		Repeat: o.Repeat && kind == thread.TargetThread, CreatedAt: f.Now(),
	}
	if fired {
		sub.FiredCount, sub.LastFiredAt = 1, sub.CreatedAt
	}
	if !fired || sub.Repeat {
		f.subs = append(f.subs, sub)
	}
	return thread.SubscribeResult{Subscription: sub, Fired: fired}, nil
}

// Unsubscribe records "Unsubscribe <id>" or "Unsubscribe <subscriber> <target>".
func (f *Fake) Unsubscribe(_ context.Context, o thread.UnsubscribeOptions) ([]thread.Subscription, error) {
	target := o.TargetThreadID + o.TargetRunID
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
		hit := (o.ID != "" && s.ID == o.ID) || (o.ID == "" && s.SubscriberID == o.SubscriberID && s.TargetID == target)
		if hit {
			out = append(out, s)
		}
		return hit
	})
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: no such subscription", thread.ErrNotFound)
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
}
