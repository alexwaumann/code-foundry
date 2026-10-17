package command_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func TestThreadSubscriptionCommands(t *testing.T) {
	const (
		settled   = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED
		idle      = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_IDLE
		attention = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ATTENTION
		finished  = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FINISHED
		auto      = v1.PermissionMode_PERMISSION_MODE_AUTO
	)
	inThread := command.Context{ActiveThreadID: "s-me"}
	listed := []*v1.ThreadSubscription{
		{Id: "sub-1", SubscriberThreadId: "s-me", SubscriberName: "Foreman", Target: v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_THREAD,
			TargetId: "s-c", TargetName: "Child", Condition: settled, Repeat: true, FiredCount: 2,
			LastFiredAt: timestamppb.New(time.Date(2026, 10, 17, 9, 30, 5, 0, time.Local)), TargetStatus: "needs attention (finished)"},
		{Id: "sub-2", SubscriberThreadId: "s-me", Target: v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_ACTION_RUN,
			TargetId: "r-1", TargetName: "Test", Condition: finished, TargetStatus: "running"},
		{Id: "sub-3", SubscriberThreadId: "s-other", Target: v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_THREAD,
			TargetId: "s-me", Condition: attention, TargetStatus: "busy (working)"},
	}
	tests := []struct {
		name           string
		cmd            string
		ctx            command.Context
		args           map[string]string
		fired, existed bool
		wantErr        error
		wantCode       connect.Code
		wantMsg        string
		wantReqs       []proto.Message
	}{
		{name: "subscribe the context thread", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"thread": "s-c", "repeat": "true"},
			wantMsg:  "subscribed sub-1: s-me wakes when thread s-c is settled (repeat)",
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me", TargetThreadId: "s-c", Condition: settled, Repeat: true}}},
		{name: "subscribe until attention", cmd: "thread.subscribe", args: map[string]string{"id": "s-p", "thread": "s-c", "until": "attention"},
			wantMsg:  "subscribed sub-1: s-p wakes when thread s-c needs attention (once)",
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-p", TargetThreadId: "s-c", Condition: attention}}},
		{name: "a one-shot that fired at once", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"thread": "s-c", "until": "idle"}, fired: true,
			wantMsg:  "woke s-me at once: thread s-c already met the condition (idle); the one-shot subscription sub-1 is done",
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me", TargetThreadId: "s-c", Condition: idle}}},
		{name: "a repeat that fired at once", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"thread": "s-c", "repeat": "true"}, fired: true,
			wantMsg: "subscribed sub-1: s-me wakes when thread s-c is settled (repeat); woke it at once: the target already met the condition"},
		{name: "already subscribed", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"thread": "s-c"}, existed: true,
			wantMsg: "already subscribed sub-1: s-me wakes when thread s-c is settled (once)"},
		{name: "subscribe to a run", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"run": "r-1"},
			wantMsg:  "subscribed sub-1: s-me wakes when run r-1 finishes (once)",
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me", TargetRunId: "r-1", Condition: settled}}},
		{name: "a run until finished", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"run": "r-1", "until": "finished"},
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me", TargetRunId: "r-1", Condition: finished}}},
		{name: "a run until idle", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"run": "r-1", "until": "idle"}, wantErr: command.ErrInvalidArgs},
		{name: "a thread until finished", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"thread": "s-c", "until": "finished"}, wantErr: command.ErrInvalidArgs},
		{name: "no target", cmd: "thread.subscribe", ctx: inThread, wantErr: command.ErrInvalidArgs},
		{name: "two targets", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"thread": "s-c", "run": "r-1"}, wantErr: command.ErrInvalidArgs},
		{name: "no subscriber", cmd: "thread.subscribe", args: map[string]string{"thread": "s-c"}, wantErr: command.ErrUnavailable},

		{name: "unsubscribe by id", cmd: "thread.unsubscribe", args: map[string]string{"subscription": "sub-2"},
			wantMsg:  "removed sub-2: s-me wakes when run r-1 finishes (once)",
			wantReqs: []proto.Message{&v1.UnsubscribeThreadRequest{SubscriptionId: "sub-2"}}},
		{name: "unsubscribe from a thread", cmd: "thread.unsubscribe", ctx: inThread, args: map[string]string{"thread": "s-c"},
			wantMsg:  "removed sub-1: s-me wakes when thread s-c is settled (repeat)",
			wantReqs: []proto.Message{&v1.UnsubscribeThreadRequest{SubscriberThreadId: "s-me", TargetThreadId: "s-c"}}},
		{name: "unsubscribe nothing", cmd: "thread.unsubscribe", ctx: inThread, wantErr: command.ErrInvalidArgs},
		{name: "unsubscribe both", cmd: "thread.unsubscribe", ctx: inThread, args: map[string]string{"subscription": "sub-1", "thread": "s-c"}, wantErr: command.ErrInvalidArgs},
		{name: "unsubscribe a target without a thread", cmd: "thread.unsubscribe", args: map[string]string{"thread": "s-c"}, wantErr: command.ErrInvalidArgs},
		{name: "unsubscribe unknown", cmd: "thread.unsubscribe", args: map[string]string{"subscription": "sub-9"}, wantCode: connect.CodeNotFound},

		{name: "list the context thread's", cmd: "thread.subscriptions", ctx: inThread,
			wantMsg: "ID     SUBSCRIBER      TARGET              UNTIL     REPEAT  FIRED  LAST FIRED  TARGET STATUS\n" +
				"sub-1  s-me (Foreman)  thread s-c (Child)  settled   yes     2      09:30:05    needs attention (finished)\n" +
				"sub-2  s-me            run r-1 (Test)      finished  no      0      -           running",
			wantReqs: []proto.Message{&v1.ListThreadSubscriptionsRequest{SubscriberThreadId: "s-me"}}},
		{name: "list all", cmd: "thread.subscriptions", ctx: inThread, args: map[string]string{"all": "true"},
			wantReqs: []proto.Message{&v1.ListThreadSubscriptionsRequest{}}},
		{name: "list none", cmd: "thread.subscriptions", args: map[string]string{"id": "s-none"}, wantMsg: "thread s-none has no wake subscriptions"},
		{name: "list needs a thread", cmd: "thread.subscriptions", wantErr: command.ErrInvalidArgs},

		{name: "new with notify", cmd: "thread.new", args: map[string]string{"repo": "r1", "created-by": "s-me", "notify": "true"},
			wantMsg:  "created thread s1 in ; s-me is woken each time it settles",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{RepoId: "r1", PermissionMode: auto, CreatedBy: "s-me", Notify: true}}},
		{name: "notify needs created-by", cmd: "thread.new", ctx: inThread, args: map[string]string{"repo": "r1", "notify": "true"}, wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			b := &commandtest.Thread{Fired: tt.fired, Existed: tt.existed, Subscriptions: slices.Clone(listed)}
			if err := command.RegisterThread(reg, b); err != nil {
				t.Fatal(err)
			}
			if err := command.RegisterThreadLifecycle(reg, b, &commandtest.Emitter{Delivered: 1}); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), tt.ctx, tt.cmd, tt.args)
			switch {
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
				return
			case !errors.Is(err, tt.wantErr):
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if tt.wantErr != nil {
				if got := b.Requests(); len(got) != 0 {
					t.Errorf("requests = %v, want none", got)
				}
				return
			}
			if tt.wantMsg != "" && res.Message != tt.wantMsg {
				t.Errorf("message =\n%s\nwant\n%s", res.Message, tt.wantMsg)
			}
			if tt.wantReqs != nil {
				if got := b.Requests(); !slices.EqualFunc(got, tt.wantReqs, proto.Equal) {
					t.Errorf("requests = %v, want %v", got, tt.wantReqs)
				}
			}
			if strings.HasPrefix(tt.cmd, "thread.sub") && res.JSON == nil {
				t.Errorf("no JSON")
			}
		})
	}
}
