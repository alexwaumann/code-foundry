package command_test

import (
	"context"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// thread.send tells a caller subscribed to the target that a wake follows, instead of
// the wait hint (E3 item 5, W2: the hint contradicted --notify).
func TestThreadSendNextStep(t *testing.T) {
	wait := "sent to thread s1 (#1); wait with: code-foundry thread wait s1 --after 1"
	sub := func(id, subscriber string, kind thread.TargetKind, target string, c thread.Condition) thread.Subscription {
		return thread.Subscription{ID: id, SubscriberID: subscriber, TargetKind: kind, TargetID: target, Condition: c}
	}
	tests := []struct {
		name   string
		caller string
		subs   []thread.Subscription
		want   string
	}{
		{name: "not in a thread", want: wait},
		{name: "no subscription", caller: "s-parent", want: wait},
		{name: "settled", caller: "s-parent", subs: []thread.Subscription{sub("sub-1", "s-parent", thread.TargetThread, "s1", thread.CondSettled)},
			want: "sent to thread s1 (#1); you are subscribed (sub-1): end your turn; it wakes you"},
		{name: "attention", caller: "s-parent", subs: []thread.Subscription{sub("sub-2", "s-parent", thread.TargetThread, "s1", thread.CondAttention)},
			want: "sent to thread s1 (#1); you are subscribed (sub-2): end your turn; it wakes you"},
		{name: "error only", caller: "s-parent", subs: []thread.Subscription{sub("sub-3", "s-parent", thread.TargetThread, "s1", thread.CondError)},
			want: wait},
		{name: "to another thread", caller: "s-parent", subs: []thread.Subscription{sub("sub-4", "s-parent", thread.TargetThread, "s9", thread.CondSettled)},
			want: wait},
		{name: "someone else's", caller: "s-parent", subs: []thread.Subscription{sub("sub-5", "s-other", thread.TargetThread, "s1", thread.CondSettled)},
			want: wait},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newThreadRegistry(t)
			for _, s := range tt.subs {
				fake.PutSubscription(s)
			}
			// The CLI's context thread is the caller; --id overlays the active thread.
			res, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: tt.caller}, "thread.send",
				map[string]string{"id": "s1", "text": "go on"})
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.want {
				t.Errorf("message %q, want %q", res.Message, tt.want)
			}
		})
	}
}
