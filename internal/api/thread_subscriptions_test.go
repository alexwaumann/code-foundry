package api

import (
	"context"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestThreadSubscriptions(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	fake.Put(thread.Thread{ID: "s-p", Name: "Parent", State: thread.StateConnected, Status: thread.StatusBusy, StatusReason: "working"})
	fake.Put(thread.Thread{ID: "s-c", Name: "Child", State: thread.StateConnected, Status: thread.StatusBusy, StatusReason: "working"})
	fake.Put(thread.Thread{ID: "s-d", State: thread.StateConnected, Status: thread.StatusIdle, StatusReason: "at prompt"})

	res, err := c.Subscribe(ctx, connect.NewRequest(&v1.SubscribeThreadRequest{SubscriberThreadId: "s-p", TargetThreadId: "s-c",
		Condition: v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ATTENTION, Repeat: true}))
	if err != nil {
		t.Fatal(err)
	}
	s := res.Msg.GetSubscription()
	if s.GetSubscriberThreadId() != "s-p" || s.GetTarget() != v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_THREAD ||
		s.GetTargetId() != "s-c" || s.GetCondition() != v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ATTENTION ||
		!s.GetRepeat() || s.GetCreatedAt() == nil || s.GetLastFiredAt() != nil || res.Msg.GetFired() {
		t.Errorf("Subscribe = %v", res.Msg)
	}
	// Unspecified is settled; an idle target fires at once.
	res, err = c.Subscribe(ctx, connect.NewRequest(&v1.SubscribeThreadRequest{SubscriberThreadId: "s-p", TargetThreadId: "s-d"}))
	if err != nil || !res.Msg.GetFired() || res.Msg.GetSubscription().GetCondition() != v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED ||
		res.Msg.GetSubscription().GetFiredCount() != 1 || res.Msg.GetSubscription().GetLastFiredAt() == nil {
		t.Errorf("Subscribe settled = %v, %v", res.Msg, err)
	}
	res, err = c.Subscribe(ctx, connect.NewRequest(&v1.SubscribeThreadRequest{SubscriberThreadId: "s-p", TargetRunId: "r-1"}))
	if err != nil || res.Msg.GetSubscription().GetTarget() != v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_ACTION_RUN ||
		res.Msg.GetSubscription().GetCondition() != v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FINISHED {
		t.Errorf("Subscribe run = %v, %v", res.Msg, err)
	}

	for _, tt := range []struct {
		req  *v1.SubscribeThreadRequest
		code connect.Code
	}{
		{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-c", TargetThreadId: "s-p"}, connect.CodeFailedPrecondition},
		{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-p", TargetThreadId: "s-p"}, connect.CodeFailedPrecondition},
		{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-p", TargetThreadId: "s-nope"}, connect.CodeNotFound},
		{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-p"}, connect.CodeInvalidArgument},
	} {
		if _, err := c.Subscribe(ctx, connect.NewRequest(tt.req)); connect.CodeOf(err) != tt.code {
			t.Errorf("Subscribe(%v) = %v, want %s", tt.req, err, tt.code)
		}
	}

	list, err := c.ListSubscriptions(ctx, connect.NewRequest(&v1.ListThreadSubscriptionsRequest{SubscriberThreadId: "s-p"}))
	if err != nil {
		t.Fatal(err)
	}
	var targets []string
	for _, s := range list.Msg.GetSubscriptions() {
		targets = append(targets, s.GetTargetId()+":"+s.GetTargetName())
	}
	if !slices.Equal(targets, []string{"s-c:Child", "r-1:"}) || list.Msg.GetSubscriptions()[0].GetSubscriberName() != "Parent" {
		t.Errorf("listed = %v", list.Msg)
	}

	gone, err := c.Unsubscribe(ctx, connect.NewRequest(&v1.UnsubscribeThreadRequest{SubscriberThreadId: "s-p", TargetRunId: "r-1"}))
	if err != nil || len(gone.Msg.GetRemoved()) != 1 {
		t.Errorf("Unsubscribe = %v, %v", gone, err)
	}
	if _, err := c.Unsubscribe(ctx, connect.NewRequest(&v1.UnsubscribeThreadRequest{SubscriptionId: "sub-nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("Unsubscribe unknown = %v", err)
	}
	if _, err := c.Create(ctx, connect.NewRequest(&v1.CreateThreadRequest{ProjectId: "r1", CreatedBy: "s-p", Notify: true})); err != nil {
		t.Fatal(err)
	}
	if calls := fake.Calls(); !slices.ContainsFunc(calls, func(c string) bool { return c == "Create r1    created-by=s-p notify" }) {
		t.Errorf("calls = %q", calls)
	}
}

func TestUserMessageOrigin(t *testing.T) {
	fake, c := newThreadServer(t)
	fake.Put(thread.Thread{ID: "s-1", State: thread.StateConnected})
	at := time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)
	fake.PutItems("s-1",
		thread.Item{ID: "u1", Kind: thread.KindUserMessage, Text: "hi", CreatedAt: at},
		thread.Item{ID: "u2", Kind: thread.KindUserMessage, Text: "[code-foundry wake] Thread s-2 is idle.\n```json\n{}\n```",
			Origin: thread.OriginWake, WakeTitle: "Thread s-2 is idle.", WakeJSON: "{}", CreatedAt: at})
	res, err := c.ListItems(context.Background(), connect.NewRequest(&v1.ListThreadItemsRequest{ThreadId: "s-1"}))
	if err != nil {
		t.Fatal(err)
	}
	items := res.Msg.GetSnapshot().GetItems()
	if len(items) != 2 {
		t.Fatalf("items = %v", items)
	}
	if u := items[0].GetUserMessage(); u.GetOrigin() != v1.MessageOrigin_MESSAGE_ORIGIN_USER || u.GetWakeTitle() != "" {
		t.Errorf("user = %v", u)
	}
	if w := items[1].GetUserMessage(); w.GetOrigin() != v1.MessageOrigin_MESSAGE_ORIGIN_WAKE || w.GetWakeTitle() != "Thread s-2 is idle." || w.GetWakeJson() != "{}" {
		t.Errorf("wake = %v", w)
	}
}

func TestThreadSubscriptionsPullRequest(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	fake.Put(thread.Thread{ID: "s-p", Name: "Parent", State: thread.StateConnected, Status: thread.StatusBusy, StatusReason: "working"})
	res, err := c.Subscribe(ctx, connect.NewRequest(&v1.SubscribeThreadRequest{SubscriberThreadId: "s-p",
		TargetPullRequest: "https://github.com/Acme/web/pull/7", Repeat: true}))
	if err != nil {
		t.Fatal(err)
	}
	s := res.Msg.GetSubscription()
	if s.GetTarget() != v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_PULL_REQUEST || s.GetTargetId() != "acme/web#7" ||
		s.GetCondition() != v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHECKS_DONE || !s.GetRepeat() {
		t.Errorf("Subscribe = %v", res.Msg)
	}
	// Every pull request condition maps both ways.
	for v, cond := range subscriptionConditions {
		if !slices.Contains(thread.PullRequestConditions, cond) {
			continue
		}
		res, err := c.Subscribe(ctx, connect.NewRequest(&v1.SubscribeThreadRequest{SubscriberThreadId: "s-p", TargetPullRequest: "acme/web#8", Condition: v}))
		if err != nil || res.Msg.GetSubscription().GetCondition() != v {
			t.Errorf("Subscribe %s = %v, %v", v, res.Msg, err)
		}
	}
	if _, err := c.Subscribe(ctx, connect.NewRequest(&v1.SubscribeThreadRequest{SubscriberThreadId: "s-p", TargetPullRequest: "acme/web#7",
		Condition: v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("settled on a pull request = %v", err)
	}
	if _, err := c.Subscribe(ctx, connect.NewRequest(&v1.SubscribeThreadRequest{SubscriberThreadId: "s-p", TargetPullRequest: "acme"})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("a bad pull request = %v", err)
	}
	gone, err := c.Unsubscribe(ctx, connect.NewRequest(&v1.UnsubscribeThreadRequest{SubscriberThreadId: "s-p", TargetPullRequest: "acme/web#7"}))
	if err != nil || len(gone.Msg.GetRemoved()) != 1 || gone.Msg.GetRemoved()[0].GetTargetId() != "acme/web#7" {
		t.Errorf("Unsubscribe = %v, %v", gone, err)
	}
}

func TestThreadSubscriptionsTimer(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	fake.Put(thread.Thread{ID: "s-p", Name: "Parent", State: thread.StateDisconnected, Status: thread.StatusIdle})
	res, err := c.Subscribe(ctx, connect.NewRequest(&v1.SubscribeThreadRequest{SubscriberThreadId: "s-p", TargetEvery: durationpb.New(30 * time.Minute)}))
	if err != nil {
		t.Fatal(err)
	}
	if s := res.Msg.GetSubscription(); s.GetTarget() != v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_TIMER || s.GetTargetId() != "every:30m" ||
		s.GetCondition() != v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FIRED || !s.GetRepeat() {
		t.Errorf("Subscribe every = %v", res.Msg)
	}
	at := time.Date(2099, 1, 2, 3, 4, 5, 0, time.UTC)
	res, err = c.Subscribe(ctx, connect.NewRequest(&v1.SubscribeThreadRequest{SubscriberThreadId: "s-p", TargetAt: timestamppb.New(at)}))
	if err != nil || res.Msg.GetSubscription().GetTargetId() != "at:2099-01-02T03:04:05.000Z" || res.Msg.GetSubscription().GetRepeat() {
		t.Errorf("Subscribe at = %v, %v", res.Msg, err)
	}
	if _, err := c.Subscribe(ctx, connect.NewRequest(&v1.SubscribeThreadRequest{SubscriberThreadId: "s-p", TargetEvery: durationpb.New(time.Second)})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("every second = %v", err)
	}
	gone, err := c.Unsubscribe(ctx, connect.NewRequest(&v1.UnsubscribeThreadRequest{SubscriberThreadId: "s-p", TargetTimer: true}))
	if err != nil || len(gone.Msg.GetRemoved()) != 2 {
		t.Errorf("Unsubscribe timers = %v, %v", gone, err)
	}
	if !slices.Contains(fake.Calls(), "Unsubscribe s-p timer") {
		t.Errorf("calls = %q", fake.Calls())
	}
}
