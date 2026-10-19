package api

import (
	"context"
	"slices"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// A plugin target travels with its args both ways; unsubscribe takes it as a target.
func TestThreadSubscriptionsPlugin(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	fake.Put(thread.Thread{ID: "s-p", Name: "Parent", State: thread.StateConnected, Status: thread.StatusBusy})
	res, err := c.Subscribe(ctx, connect.NewRequest(&v1.SubscribeThreadRequest{SubscriberThreadId: "s-p", TargetPlugin: "hello/tick",
		Args: map[string]string{"every": "2s"}, Repeat: true}))
	if err != nil {
		t.Fatal(err)
	}
	s := res.Msg.GetSubscription()
	if s.GetTarget() != v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_PLUGIN || s.GetTargetId() != "hello/tick" ||
		s.GetCondition() != v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FIRED || s.GetArgs()["every"] != "2s" || !s.GetRepeat() {
		t.Errorf("Subscribe = %v", res.Msg)
	}
	if calls := fake.Calls(); !slices.Contains(calls, "Subscribe s-p plugin hello/tick fired repeat=true args=every=2s") {
		t.Errorf("calls = %q", calls)
	}
	gone, err := c.Unsubscribe(ctx, connect.NewRequest(&v1.UnsubscribeThreadRequest{SubscriberThreadId: "s-p", TargetPlugin: "hello/tick"}))
	if err != nil || len(gone.Msg.GetRemoved()) != 1 || gone.Msg.GetRemoved()[0].GetArgs()["every"] != "2s" {
		t.Errorf("Unsubscribe = %v, %v", gone, err)
	}
}

func TestPluginWakesToProto(t *testing.T) {
	got := pluginWakesToProto("gh", []pluginsdk.WakeSpec{{Name: "checks-done", Title: "Checks done", Description: "All checks completed.",
		Scope: pluginsdk.WakeScopePR, Args: []pluginsdk.WakeArgSpec{
			{Name: "pr", Context: pluginsdk.WakeContextPR, Required: true},
			{Name: "conclusion", Type: pluginsdk.ArgEnum, Enum: []string{"success", "failure"}},
			{Name: "job", Required: true},
		}}, {Name: "tick", Title: "Tick"}})
	if len(got) != 2 {
		t.Fatalf("got %v", got)
	}
	w := got[0]
	if w.GetScope() != "pr" || w.GetSubscribeLine() != "code-foundry thread subscribe --plugin gh/checks-done --arg job=<job>" ||
		len(w.GetArgs()) != 3 || w.GetArgs()[0].GetContext() != "pr" || w.GetArgs()[0].GetType() != "string" ||
		w.GetArgs()[1].GetType() != "enum" || !slices.Equal(w.GetArgs()[1].GetEnumValues(), []string{"success", "failure"}) {
		t.Errorf("wake = %v", w)
	}
	if got[1].GetScope() != "global" || got[1].GetSubscribeLine() != "code-foundry thread subscribe --plugin gh/tick" {
		t.Errorf("tick = %v", got[1])
	}
}
