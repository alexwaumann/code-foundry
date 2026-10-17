package commandtest

import (
	"context"
	"fmt"
	"slices"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Subscribe echoes the request as subscription "sub-1" (condition unspecified becomes
// settled for a thread, finished for a run), with Fired and Existed as set.
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
			sub.GetTargetId() == m.GetTargetThreadId()+m.GetTargetRunId())
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
