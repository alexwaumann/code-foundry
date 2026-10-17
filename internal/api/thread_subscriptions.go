package api

import (
	"context"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Wake subscriptions (docs/notes/agents-4-wake.md): the Subscribe, Unsubscribe and
// ListSubscriptions handlers, the subscription mapping, and the origin of a user
// message item. The store validates, fires and delivers.

var subscriptionConditions = map[v1.ThreadSubscriptionCondition]thread.Condition{
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED:      thread.CondSettled,
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_IDLE:         thread.CondIdle,
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ATTENTION:    thread.CondAttention,
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ERROR:        thread.CondError,
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_DISCONNECTED: thread.CondDisconnected,
	v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FINISHED:     thread.CondFinished,
}

var subscriptionTargets = map[thread.TargetKind]v1.ThreadSubscriptionTarget{
	thread.TargetThread:    v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_THREAD,
	thread.TargetActionRun: v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_ACTION_RUN,
}

// subscriptionToProto maps a subscription.
func subscriptionToProto(s thread.Subscription) *v1.ThreadSubscription {
	p := &v1.ThreadSubscription{
		Id: s.ID, SubscriberThreadId: s.SubscriberID, Target: subscriptionTargets[s.TargetKind], TargetId: s.TargetID,
		Repeat: s.Repeat, FiredCount: int64(s.FiredCount),
		SubscriberName: s.SubscriberName, TargetName: s.TargetName, TargetStatus: s.TargetStatus,
	}
	for v, c := range subscriptionConditions {
		if c == s.Condition {
			p.Condition = v
		}
	}
	if !s.CreatedAt.IsZero() {
		p.CreatedAt = timestamppb.New(s.CreatedAt)
	}
	if !s.LastFiredAt.IsZero() {
		p.LastFiredAt = timestamppb.New(s.LastFiredAt)
	}
	return p
}

// userMessageToProto maps a user_message item's payload, with its origin.
func userMessageToProto(it thread.Item) *v1.UserMessageItem {
	p := &v1.UserMessageItem{Text: it.Text, Attachments: it.Attachments, ComposerText: it.ComposerText,
		Origin: v1.MessageOrigin_MESSAGE_ORIGIN_USER}
	if it.Origin == thread.OriginWake {
		p.Origin, p.WakeTitle, p.WakeJson = v1.MessageOrigin_MESSAGE_ORIGIN_WAKE, it.WakeTitle, it.WakeJSON
	}
	return p
}

// Subscribe makes a wake subscription.
func (h *Thread) Subscribe(ctx context.Context, req *connect.Request[v1.SubscribeThreadRequest]) (*connect.Response[v1.SubscribeThreadResponse], error) {
	m := req.Msg
	res, err := h.store.Subscribe(ctx, thread.SubscribeOptions{
		SubscriberID: m.GetSubscriberThreadId(), TargetThreadID: m.GetTargetThreadId(), TargetRunID: m.GetTargetRunId(),
		Condition: subscriptionConditions[m.GetCondition()], Repeat: m.GetRepeat(),
	})
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.SubscribeThreadResponse{
		Subscription: subscriptionToProto(res.Subscription), Fired: res.Fired, Existed: res.Existed,
	}), nil
}

// Unsubscribe removes subscriptions by id or by subscriber and target.
func (h *Thread) Unsubscribe(ctx context.Context, req *connect.Request[v1.UnsubscribeThreadRequest]) (*connect.Response[v1.UnsubscribeThreadResponse], error) {
	m := req.Msg
	gone, err := h.store.Unsubscribe(ctx, thread.UnsubscribeOptions{
		ID: m.GetSubscriptionId(), SubscriberID: m.GetSubscriberThreadId(), TargetThreadID: m.GetTargetThreadId(), TargetRunID: m.GetTargetRunId(),
	})
	if err != nil {
		return nil, threadError(err)
	}
	out := &v1.UnsubscribeThreadResponse{}
	for _, s := range gone {
		out.Removed = append(out.Removed, subscriptionToProto(s))
	}
	return connect.NewResponse(out), nil
}

// ListSubscriptions lists a subscriber's subscriptions, or every thread's.
func (h *Thread) ListSubscriptions(ctx context.Context, req *connect.Request[v1.ListThreadSubscriptionsRequest]) (*connect.Response[v1.ListThreadSubscriptionsResponse], error) {
	subs, err := h.store.Subscriptions(ctx, req.Msg.GetSubscriberThreadId())
	if err != nil {
		return nil, threadError(err)
	}
	out := &v1.ListThreadSubscriptionsResponse{}
	for _, s := range subs {
		out.Subscriptions = append(out.Subscriptions, subscriptionToProto(s))
	}
	return connect.NewResponse(out), nil
}
