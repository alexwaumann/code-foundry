package commandtest

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Subscribe echoes the request as subscription "sub-1" (condition unspecified becomes
// settled for a thread, finished for a run, checks_done for a pull request, which is
// kept as given, fired for a plugin, whose args it keeps, and a timer, "at:<UTC>" or
// "every:<interval>"), with Fired and Existed as set.
func (s *Thread) Subscribe(_ context.Context, r *connect.Request[v1.SubscribeThreadRequest]) (*connect.Response[v1.SubscribeThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	m := r.Msg
	sub := &v1.ThreadSubscription{Id: "sub-1", SubscriberThreadId: m.GetSubscriberThreadId(), Repeat: m.GetRepeat(), Condition: m.GetCondition(),
		Target: v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_THREAD, TargetId: m.GetTargetThreadId()}
	if m.GetTargetRunId() != "" {
		sub.Target, sub.TargetId, sub.Repeat = v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_ACTION_RUN, m.GetTargetRunId(), false
		sub.Condition = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FINISHED
	}
	if pr := m.GetTargetPullRequest(); pr != "" {
		sub.Target, sub.TargetId = v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_PULL_REQUEST, pr
		if sub.Condition == v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_UNSPECIFIED {
			sub.Condition = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHECKS_DONE
		}
	}
	if m.GetTargetPlugin() != "" {
		sub.Target, sub.TargetId, sub.Args = v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_PLUGIN, m.GetTargetPlugin(), m.GetArgs()
		sub.Condition = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FIRED
	}
	if at := m.GetTargetAt(); at != nil {
		sub.Target, sub.TargetId, sub.Repeat = v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_TIMER, "at:"+at.AsTime().UTC().Format(time.RFC3339), false
		sub.Condition = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FIRED
	}
	if every := m.GetTargetEvery(); every != nil {
		sub.Target, sub.TargetId, sub.Repeat = v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_TIMER, "every:"+strings.Replace(strings.Replace(every.AsDuration().String(), "m0s", "m", 1), "h0m", "h", 1), true
		sub.Condition = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FIRED
	}
	if sub.Condition == v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_UNSPECIFIED {
		sub.Condition = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED
	}
	if s.Fired {
		sub.FiredCount = 1
	}
	return connect.NewResponse(&v1.SubscribeThreadResponse{Subscription: sub, Fired: s.Fired, Existed: s.Existed}), nil
}

// Unsubscribe removes the matching Subscriptions (by id, or subscriber and target) and
// returns them; NOT_FOUND when none matched.
func (s *Thread) Unsubscribe(_ context.Context, r *connect.Request[v1.UnsubscribeThreadRequest]) (*connect.Response[v1.UnsubscribeThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	m := r.Msg
	out := &v1.UnsubscribeThreadResponse{}
	s.Subscriptions = slices.DeleteFunc(s.Subscriptions, func(sub *v1.ThreadSubscription) bool {
		hit := sub.GetId() == m.GetSubscriptionId() || (m.GetSubscriptionId() == "" && sub.GetSubscriberThreadId() == m.GetSubscriberThreadId() &&
			(sub.GetTargetId() == m.GetTargetThreadId()+m.GetTargetRunId()+m.GetTargetPullRequest()+m.GetTargetPlugin() ||
				(m.GetTargetTimer() && sub.GetTarget() == v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_TIMER)))
		if hit {
			out.Removed = append(out.Removed, sub)
		}
		return hit
	})
	if len(out.Removed) == 0 {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no such subscription"))
	}
	return connect.NewResponse(out), nil
}

// ListSubscriptions returns Subscriptions of the subscriber (all for none).
func (s *Thread) ListSubscriptions(_ context.Context, r *connect.Request[v1.ListThreadSubscriptionsRequest]) (*connect.Response[v1.ListThreadSubscriptionsResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	out := &v1.ListThreadSubscriptionsResponse{}
	for _, sub := range s.Subscriptions {
		if id := r.Msg.GetSubscriberThreadId(); id == "" || sub.GetSubscriberThreadId() == id {
			out.Subscriptions = append(out.Subscriptions, sub)
		}
	}
	return connect.NewResponse(out), nil
}
