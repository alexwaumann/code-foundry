package command_test

import (
	"context"
	"testing"
	"time"

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

// thread.send --wait settles at a permission prompt the message led to and names it,
// instead of waiting out --for (docs/notes/thread-wait-settled.md).
func TestThreadSendWaitSettlesAtPrompt(t *testing.T) {
	finished := thread.Thread{ID: "s1", Name: "fix", State: thread.StateConnected, Status: thread.StatusNeedsAttention, StatusReason: "finished"}
	busy, asking := finished, finished
	busy.Status, busy.StatusReason = thread.StatusBusy, "working"
	asking.StatusReason = "permission: Bash rm x"
	reg, fake := newThreadRegistry(t)
	fake.Put(finished)
	fake.PutItems("s1", thread.Item{ID: "u-old", Kind: thread.KindUserMessage, Text: "hi"}, thread.Item{ID: "t-old", Kind: thread.KindTurnEnd})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	type answer struct {
		res command.Result
		err error
	}
	done := make(chan answer, 1)
	go func() {
		res, err := reg.Invoke(ctx, command.Context{}, "thread.send", map[string]string{"id": "s1", "text": "remove x", "wait": "true", "for": "5s"})
		done <- answer{res, err}
	}()
	for _, step := range []func(){
		func() { fake.Put(busy) },
		func() {
			fake.AppendItem("s1", thread.Item{ID: "p-r1", Kind: thread.KindPermission, Request: &thread.Request{
				RequestID: "r1", ToolName: "Bash", Description: "rm x", InputJSON: `{"command":"rm x"}`, State: thread.RequestPending}})
			fake.Put(asking)
		},
	} {
		select {
		case a := <-done:
			t.Fatalf("returned (%q, %v) early", a.res.Message, a.err)
		case <-time.After(30 * time.Millisecond):
		}
		step()
	}
	a := <-done
	want := "thread s1 fix: needs attention (permission: Bash rm x)\n" +
		`pending permission r1: Bash {"command":"rm x"}; answer with: code-foundry thread respond --id s1 allow (or deny --message "why")`
	if a.err != nil || a.res.Message != want {
		t.Fatalf("answer %q, %v; want %q", a.res.Message, a.err, want)
	}
}
