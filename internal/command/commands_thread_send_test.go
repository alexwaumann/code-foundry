package command_test

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// thread.send tells the caller what comes next: from a thread to another thread, what its
// reply mark means for it (docs/notes/thread-reply-mark.md); from the user, the wait hint,
// or that a subscription wakes it (E3 item 5, W2: the hint contradicted --notify).
func TestThreadSendNextStep(t *testing.T) {
	wait := "sent to thread s1 (#1); wait with: code-foundry thread wait s1 --after 1"
	woken := "sent to thread s1 (#1). Delivered. You will be woken when it answers; do not poll it."
	told := "sent to thread s1 (#1). Delivered, no reply expected. You will not hear back, not even a confirmation, unless that thread needs something from you."
	sub := func(id, subscriber string, kind thread.TargetKind, target string, c thread.Condition) thread.Subscription {
		return thread.Subscription{ID: id, SubscriberID: subscriber, TargetKind: kind, TargetID: target, Condition: c}
	}
	settled := []thread.Subscription{sub("sub-1", "s-parent", thread.TargetThread, "s1", thread.CondSettled)}
	tests := []struct {
		name   string
		caller string
		reply  string
		subs   []thread.Subscription
		want   string
	}{
		{name: "not in a thread", want: wait},
		{name: "the user subscribed", subs: settled, want: wait},
		{name: "wanted, subscribed", caller: "s-parent", reply: "wanted", subs: settled, want: woken},
		{name: "wanted, a reply-wait", caller: "s-parent", reply: "wanted",
			subs: []thread.Subscription{sub("sub-2", "s-parent", thread.TargetThread, "s1", thread.CondIdle)}, want: woken},
		{name: "wanted, attention", caller: "s-parent", reply: "wanted",
			subs: []thread.Subscription{sub("sub-3", "s-parent", thread.TargetThread, "s1", thread.CondAttention)}, want: woken},
		{name: "wanted, no wake set up", caller: "s-parent", reply: "wanted",
			want: "sent to thread s1 (#1). Delivered, but no wake could be set up for its answer: wait with code-foundry thread wait s1 --after 1"},
		{name: "wanted, an error subscription is no answer's", caller: "s-parent", reply: "wanted",
			subs: []thread.Subscription{sub("sub-4", "s-parent", thread.TargetThread, "s1", thread.CondError)},
			want: "sent to thread s1 (#1). Delivered, but no wake could be set up for its answer: wait with code-foundry thread wait s1 --after 1"},
		{name: "wanted, a subscription to another thread", caller: "s-parent", reply: "wanted",
			subs: []thread.Subscription{sub("sub-5", "s-parent", thread.TargetThread, "s9", thread.CondSettled)},
			want: "sent to thread s1 (#1). Delivered, but no wake could be set up for its answer: wait with code-foundry thread wait s1 --after 1"},
		{name: "wanted, someone else's", caller: "s-parent", reply: "wanted",
			subs: []thread.Subscription{sub("sub-6", "s-other", thread.TargetThread, "s1", thread.CondSettled)},
			want: "sent to thread s1 (#1). Delivered, but no wake could be set up for its answer: wait with code-foundry thread wait s1 --after 1"},
		{name: "none", caller: "s-parent", reply: "none", want: told},
		{name: "none, still subscribed", caller: "s-parent", reply: "none", subs: settled,
			want: told + " (Your subscription sub-1 to it still wakes you when its turn ends.)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newThreadRegistry(t)
			for _, s := range tt.subs {
				fake.PutSubscription(s)
			}
			args := map[string]string{"id": "s1", "text": "go on"}
			if tt.reply != "" {
				args["reply"] = tt.reply
			}
			// The CLI's context thread is the caller; --id overlays the active thread.
			res, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: tt.caller}, "thread.send", args)
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.want {
				t.Errorf("message %q, want %q", res.Message, tt.want)
			}
		})
	}
}

// From a thread to another thread, thread.send needs --reply: the daemon refuses it
// without, and says what the two choices mean; --wait is a wanted reply, and refuses none.
func TestThreadSendReplyMark(t *testing.T) {
	tests := []struct {
		name     string
		ctx      command.Context
		args     map[string]string
		wantErr  string
		wantCall string
	}{
		{name: "a thread without a mark", ctx: command.Context{ActiveThreadID: "s-parent"}, args: map[string]string{"id": "s1", "text": "hi"},
			wantErr: "--reply wanted when you need its answer"},
		{name: "a thread, wanted", ctx: command.Context{ActiveThreadID: "s-parent"}, args: map[string]string{"id": "s1", "text": "hi", "reply": "wanted"},
			wantCall: "Send s1 hi reply=wanted"},
		{name: "a thread, none", ctx: command.Context{ActiveThreadID: "s-parent"}, args: map[string]string{"id": "s1", "text": "hi", "reply": "none"},
			wantCall: "Send s1 hi reply=none"},
		{name: "a thread, --wait is wanted", ctx: command.Context{ActiveThreadID: "s-parent"},
			args: map[string]string{"id": "s1", "text": "hi", "wait": "true", "for": "1ms"}, wantCall: "Send s1 hi no-notify reply=wanted"},
		{name: "--wait with none", ctx: command.Context{ActiveThreadID: "s-parent"},
			args: map[string]string{"id": "s1", "text": "hi", "wait": "true", "reply": "none"}, wantErr: "--wait waits for its answer"},
		{name: "an unknown mark", ctx: command.Context{ActiveThreadID: "s-parent"}, args: map[string]string{"id": "s1", "text": "hi", "reply": "maybe"},
			wantErr: "maybe"},
		{name: "the user's message needs none", args: map[string]string{"id": "s1", "text": "hi"}, wantCall: "Send s1 hi"},
		{name: "the app's message needs none", ctx: command.Context{ActiveThreadID: "s1", ActiveView: "thread"}, args: map[string]string{"text": "hi"},
			wantCall: "Send s1 hi"},
		{name: "a thread to itself needs none", ctx: command.Context{ActiveThreadID: "s1"}, args: map[string]string{"text": "hi"}, wantCall: "Send s1 hi"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newThreadRegistry(t)
			_, err := reg.Invoke(context.Background(), tt.ctx, "thread.send", tt.args)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want it to say %q", err, tt.wantErr)
				}
				if calls := fake.Calls(); slices.ContainsFunc(calls, func(c string) bool { return strings.HasPrefix(c, "Send ") }) {
					t.Errorf("a send went out: %q", calls)
				}
				return
			}
			if err != nil && !strings.Contains(err.Error(), "timed out") {
				t.Fatal(err)
			}
			if calls := fake.Calls(); !slices.Contains(calls, tt.wantCall) {
				t.Errorf("calls = %q, want %q", calls, tt.wantCall)
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
