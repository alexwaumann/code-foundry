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
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestThreadSubscriptionCommands(t *testing.T) {
	const (
		settled   = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_SETTLED
		idle      = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_IDLE
		attention = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_ATTENTION
		finished  = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FINISHED
		review    = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_REVIEW
		checks    = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_CHECKS_DONE
		fired     = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_FIRED
		unset     = v1.ThreadSubscriptionCondition_THREAD_SUBSCRIPTION_CONDITION_UNSPECIFIED
		auto      = v1.PermissionMode_PERMISSION_MODE_AUTO
	)
	inThread := command.Context{ActiveThreadID: "s-me"}
	listed := []*v1.ThreadSubscription{
		{Id: "sub-1", SubscriberThreadId: "s-me", SubscriberName: "Foreman", Target: v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_THREAD,
			TargetId: "s-c", TargetName: "Child", Condition: settled, Repeat: true, FiredCount: 2,
			LastFiredAt: timestamppb.New(time.Date(2026, 10, 17, 9, 30, 5, 0, time.FixedZone("CDT", -5*3600))), TargetStatus: "needs attention (finished)"},
		{Id: "sub-2", SubscriberThreadId: "s-me", Target: v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_ACTION_RUN,
			TargetId: "r-1", TargetName: "Test", Condition: finished, TargetStatus: "running"},
		{Id: "sub-3", SubscriberThreadId: "s-other", Target: v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_THREAD,
			TargetId: "s-me", Condition: attention, TargetStatus: "busy (working)"},
		{Id: "sub-4", SubscriberThreadId: "s-me", Target: v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_PULL_REQUEST,
			TargetId: "acme/web#7", TargetName: "acme/web#7 Retry", Condition: review, Repeat: true, TargetStatus: "open · checks pending (2/4)"},
		{Id: "sub-5", SubscriberThreadId: "s-other", Target: v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_PLUGIN,
			TargetId: "hello/tick", TargetName: "Hello: Tick", Condition: fired, Args: map[string]string{"every": "2s", "a": "b"}, TargetStatus: "running"},
		{Id: "sub-6", SubscriberThreadId: "s-timed", Target: v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_TIMER,
			TargetId: "every:30m", TargetName: "every 30m", Condition: fired, Repeat: true, FiredCount: 1, TargetStatus: "next 10:30 CDT"},
		{Id: "sub-7", SubscriberThreadId: "s-timed", Target: v1.ThreadSubscriptionTarget_THREAD_SUBSCRIPTION_TARGET_TIMER,
			TargetId: "at:2026-10-20T19:00:00.000Z", TargetName: "at 14:00 CDT", Condition: fired, TargetStatus: "next 14:00 CDT",
			Note: "remind the user to review the PWA branch (t-aa39dec3)"},
	}
	// Times print local, as the store's listing and the wake say them (e13-5).
	sevenPM := thread.ClockTime(time.Date(2026, 10, 20, 19, 0, 0, 0, time.UTC), time.Now())
	at2099 := thread.ClockTime(time.Date(2099, 10, 20, 19, 0, 0, 0, time.UTC), time.Now())
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
		wantJSON       string // the --json answer, spaces removed
	}{
		{name: "subscribe the context thread", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"thread": "s-c", "repeat": "true"},
			wantMsg:  "subscribed sub-1: s-me wakes when thread s-c is settled (repeat)",
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me", TargetThreadId: "s-c", Repeat: true}}},
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
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me", TargetRunId: "r-1"}}},
		{name: "subscribe to a pull request", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"pr": "acme/web#7"},
			wantMsg:  "subscribed sub-1: s-me wakes when pr acme/web#7 finishes its checks (once)",
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me", TargetPullRequest: "acme/web#7"}},
			wantJSON: `{"subscription":{"id":"sub-1","subscriberThreadId":"s-me","target":"THREAD_SUBSCRIPTION_TARGET_PULL_REQUEST",` +
				`"targetId":"acme/web#7","condition":"THREAD_SUBSCRIPTION_CONDITION_CHECKS_DONE"}}`},
		{name: "a pull request's reviews", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"pr": "https://github.com/acme/web/pull/7", "until": "review", "repeat": "true"},
			wantMsg:  "subscribed sub-1: s-me wakes when pr https://github.com/acme/web/pull/7 gets a review (repeat)",
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me", TargetPullRequest: "https://github.com/acme/web/pull/7", Condition: review, Repeat: true}}},
		{name: "a pull request merged at once", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"pr": "acme/web#7", "until": "merged"}, fired: true,
			wantMsg: "woke s-me at once: pr acme/web#7 already met the condition (merged); the one-shot subscription sub-1 is done"},
		{name: "a pull request until settled", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"pr": "acme/web#7", "until": "settled"}, wantErr: command.ErrInvalidArgs},
		{name: "a thread until checks_done", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"thread": "s-c", "until": "checks_done"}, wantErr: command.ErrInvalidArgs},
		{name: "a run until merged", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"run": "r-1", "until": "merged"}, wantErr: command.ErrInvalidArgs},
		{name: "a run and a pull request", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"run": "r-1", "pr": "acme/web#7"}, wantErr: command.ErrInvalidArgs},
		{name: "a run until finished", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"run": "r-1", "until": "finished"},
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me", TargetRunId: "r-1", Condition: finished}}},
		{name: "a run until idle", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"run": "r-1", "until": "idle"}, wantErr: command.ErrInvalidArgs},
		{name: "a thread until finished", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"thread": "s-c", "until": "finished"}, wantErr: command.ErrInvalidArgs},
		{name: "no target", cmd: "thread.subscribe", ctx: inThread, wantErr: command.ErrInvalidArgs},
		{name: "two targets", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"thread": "s-c", "run": "r-1"}, wantErr: command.ErrInvalidArgs},
		{name: "no subscriber", cmd: "thread.subscribe", args: map[string]string{"thread": "s-c"}, wantErr: command.ErrInvalidArgs},
		{name: "subscribe to a plugin's wake source", cmd: "thread.subscribe", ctx: inThread,
			args:     map[string]string{"plugin": "hello/tick", "arg": "every=2s\n\n pr = a/b#1 ", "repeat": "true"},
			wantMsg:  "subscribed sub-1: s-me wakes when plugin hello/tick fires (every=2s pr=a/b#1) (repeat)",
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me", TargetPlugin: "hello/tick", Args: map[string]string{"every": "2s", "pr": "a/b#1"}, Condition: unset, Repeat: true}}},
		{name: "a plugin without args", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"plugin": "hello/tick"},
			wantMsg:  "subscribed sub-1: s-me wakes when plugin hello/tick fires (once)",
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me", TargetPlugin: "hello/tick", Condition: unset}}},
		{name: "an arg value with =", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"plugin": "x/y", "arg": "q=a=b"},
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me", TargetPlugin: "x/y", Args: map[string]string{"q": "a=b"}, Condition: unset}}},
		{name: "an arg without =", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"plugin": "hello/tick", "arg": "every"}, wantErr: command.ErrInvalidArgs},
		{name: "an arg twice", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"plugin": "hello/tick", "arg": "every=1s\nevery=2s"}, wantErr: command.ErrInvalidArgs},
		{name: "args without a plugin", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"thread": "s-c", "arg": "every=1s"}, wantErr: command.ErrInvalidArgs},
		{name: "a plugin until idle", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"plugin": "hello/tick", "until": "idle"}, wantErr: command.ErrInvalidArgs},
		{name: "a plugin and a thread", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"plugin": "hello/tick", "thread": "s-c"}, wantErr: command.ErrInvalidArgs},
		{name: "a timer every 30m", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"every": "30m"},
			wantMsg:  "subscribed sub-1: s-me wakes every 30m (repeat)",
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me", TargetEvery: durationpb.New(30 * time.Minute), Condition: unset}}},
		{name: "a timer at a time", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"at": "2099-10-20T14:00:00-05:00"},
			wantMsg: "subscribed sub-1: s-me wakes at " + at2099 + " (once)",
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me",
				TargetAt: timestamppb.New(time.Date(2099, 10, 20, 19, 0, 0, 0, time.UTC)), Condition: unset}}},
		{name: "a timer in two hours", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"at": "2h"}},
		{name: "a timer with a note", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"every": "2m", "note": "ping the user (t-aa39dec3)"},
			wantMsg:  "subscribed sub-1: s-me wakes every 2m (repeat) · ping the user (t-aa39dec3)",
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me", TargetEvery: durationpb.New(2 * time.Minute), Condition: unset, Note: "ping the user (t-aa39dec3)"}}},
		{name: "a note too long", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"every": "2m", "note": strings.Repeat("x", 201)}, wantErr: command.ErrInvalidArgs},
		{name: "a timer until settled", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"every": "1h", "until": "settled"},
			wantReqs: []proto.Message{&v1.SubscribeThreadRequest{SubscriberThreadId: "s-me", TargetEvery: durationpb.New(time.Hour), Condition: unset}}},
		{name: "a timer under a minute", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"every": "30s"}, wantErr: command.ErrInvalidArgs},
		{name: "a timer at nonsense", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"at": "tomorrow"}, wantErr: command.ErrInvalidArgs},
		{name: "a timer at a past duration", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"at": "-5m"}, wantErr: command.ErrInvalidArgs},
		{name: "a timer at and every", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"at": "5m", "every": "5m"}, wantErr: command.ErrInvalidArgs},
		{name: "a timer and a thread", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"every": "5m", "thread": "s-c"}, wantErr: command.ErrInvalidArgs},
		{name: "a timer until idle", cmd: "thread.subscribe", ctx: inThread, args: map[string]string{"every": "5m", "until": "idle"}, wantErr: command.ErrInvalidArgs},

		{name: "unsubscribe by id", cmd: "thread.unsubscribe", args: map[string]string{"subscription": "sub-2"},
			wantMsg:  "removed sub-2: s-me wakes when run r-1 finishes (once)",
			wantReqs: []proto.Message{&v1.UnsubscribeThreadRequest{SubscriptionId: "sub-2"}}},
		{name: "unsubscribe from a thread", cmd: "thread.unsubscribe", ctx: inThread, args: map[string]string{"thread": "s-c"},
			wantMsg:  "removed sub-1: s-me wakes when thread s-c is settled (repeat)",
			wantReqs: []proto.Message{&v1.UnsubscribeThreadRequest{SubscriberThreadId: "s-me", TargetThreadId: "s-c"}}},
		{name: "unsubscribe from a pull request", cmd: "thread.unsubscribe", ctx: inThread, args: map[string]string{"pr": "acme/web#7"},
			wantMsg:  "removed sub-4: s-me wakes when pr acme/web#7 gets a review (repeat)",
			wantReqs: []proto.Message{&v1.UnsubscribeThreadRequest{SubscriberThreadId: "s-me", TargetPullRequest: "acme/web#7"}},
			wantJSON: `{"removed":[{"id":"sub-4","subscriberThreadId":"s-me","target":"THREAD_SUBSCRIPTION_TARGET_PULL_REQUEST","targetId":"acme/web#7",` +
				`"condition":"THREAD_SUBSCRIPTION_CONDITION_REVIEW","repeat":true,"targetName":"acme/web#7Retry","targetStatus":"open·checkspending(2/4)"}]}`},
		{name: "unsubscribe from a plugin's wake source", cmd: "thread.unsubscribe", args: map[string]string{"id": "s-other", "plugin": "hello/tick"},
			wantMsg:  "removed sub-5: s-other wakes when plugin hello/tick fires (a=b every=2s) (once)",
			wantReqs: []proto.Message{&v1.UnsubscribeThreadRequest{SubscriberThreadId: "s-other", TargetPlugin: "hello/tick"}}},
		{name: "unsubscribe the timers", cmd: "thread.unsubscribe", args: map[string]string{"id": "s-timed", "timers": "true"},
			wantMsg: "removed sub-6: s-timed wakes every 30m (repeat)\nremoved sub-7: s-timed wakes at " + sevenPM +
				" (once) · remind the user to review the PWA branch (t-aa39dec3)",
			wantReqs: []proto.Message{&v1.UnsubscribeThreadRequest{SubscriberThreadId: "s-timed", TargetTimer: true}}},
		{name: "unsubscribe timers and a thread", cmd: "thread.unsubscribe", ctx: inThread, args: map[string]string{"timers": "true", "thread": "s-c"}, wantErr: command.ErrInvalidArgs},
		{name: "unsubscribe nothing", cmd: "thread.unsubscribe", ctx: inThread, wantErr: command.ErrInvalidArgs},
		{name: "unsubscribe an id and a pull request", cmd: "thread.unsubscribe", ctx: inThread, args: map[string]string{"subscription": "sub-4", "pr": "acme/web#7"}, wantErr: command.ErrInvalidArgs},
		{name: "unsubscribe both", cmd: "thread.unsubscribe", ctx: inThread, args: map[string]string{"subscription": "sub-1", "thread": "s-c"}, wantErr: command.ErrInvalidArgs},
		{name: "unsubscribe a target without a thread", cmd: "thread.unsubscribe", args: map[string]string{"thread": "s-c"}, wantErr: command.ErrInvalidArgs},
		{name: "unsubscribe unknown", cmd: "thread.unsubscribe", args: map[string]string{"subscription": "sub-9"}, wantCode: connect.CodeNotFound},

		{name: "list the context thread's", cmd: "thread.subscriptions", ctx: inThread,
			wantMsg: "ID     SUBSCRIBER      TARGET               UNTIL     REPEAT  FIRED  LAST FIRED            TARGET STATUS\n" +
				"sub-1  s-me (Foreman)  thread s-c (Child)   settled   yes     2      2026-10-17T14:30:05Z  needs attention (finished)\n" +
				"sub-2  s-me            run r-1 (Test)       finished  no      0      -                     running\n" +
				"sub-4  s-me            pr acme/web#7 Retry  review    yes     0      -                     open · checks pending (2/4)",
			wantReqs: []proto.Message{&v1.ListThreadSubscriptionsRequest{SubscriberThreadId: "s-me"}}},
		{name: "list all", cmd: "thread.subscriptions", ctx: inThread, args: map[string]string{"all": "true"},
			wantReqs: []proto.Message{&v1.ListThreadSubscriptionsRequest{}}},
		{name: "list a plugin target", cmd: "thread.subscriptions", args: map[string]string{"id": "s-other"},
			wantMsg: "ID     SUBSCRIBER  TARGET                                        UNTIL      REPEAT  FIRED  LAST FIRED  TARGET STATUS\n" +
				"sub-3  s-other     thread s-me                                   attention  no      0      -           busy (working)\n" +
				"sub-5  s-other     plugin hello/tick a=b every=2s (Hello: Tick)  fired      no      0      -           running"},
		{name: "list timers", cmd: "thread.subscriptions", args: map[string]string{"id": "s-timed"},
			wantMsg: "ID     SUBSCRIBER  TARGET              UNTIL  REPEAT  FIRED  LAST FIRED  TARGET STATUS   NOTE\n" +
				"sub-6  s-timed     timer every 30m     fired  yes     1      -           next 10:30 CDT\n" +
				"sub-7  s-timed     timer at 14:00 CDT  fired  no      0      -           next 14:00 CDT  remind the user to review the PWA branch (t-aa39dec3)"},
		{name: "list none", cmd: "thread.subscriptions", args: map[string]string{"id": "s-none"}, wantMsg: "thread s-none has no wake subscriptions"},
		{name: "list needs a thread", cmd: "thread.subscriptions", wantErr: command.ErrInvalidArgs},

		{name: "new with notify", cmd: "thread.new", args: map[string]string{"project": "r1", "created-by": "s-me", "notify": "true"},
			wantMsg:  "created thread s1 in ; s-me is woken each time it settles",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", PermissionMode: auto, CreatedBy: "s-me", Notify: true}}},
		{name: "notify needs created-by", cmd: "thread.new", ctx: inThread, args: map[string]string{"project": "r1", "notify": "true"}, wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			b := &commandtest.Thread{Fired: tt.fired, Existed: tt.existed, Subscriptions: slices.Clone(listed)}
			if err := command.RegisterThread(reg, b); err != nil {
				t.Fatal(err)
			}
			if err := command.RegisterThreadLifecycle(reg, b, &commandtest.Emitter{Delivered: 1, OpenWindows: 1}); err != nil {
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
			if tt.wantJSON != "" {
				got, err := res.EncodeJSON()
				if got = strings.ReplaceAll(got, " ", ""); err != nil || got != tt.wantJSON {
					t.Errorf("JSON =\n%s\nwant\n%s", got, tt.wantJSON)
				}
			}
		})
	}
}
