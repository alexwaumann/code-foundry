package api

import (
	"context"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Snooze with an event goes to SnoozeUntilEvent and comes back with what it waits on; the
// thread carries why a past one ended (docs/notes/snooze-until-event.md).
func TestThreadSnoozeEvent(t *testing.T) {
	now := time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)
	tests := []struct {
		name     string
		req      *v1.SnoozeThreadRequest
		wantCode connect.Code
		wantCall string
		want     *v1.ThreadSnoozeEvent
	}{
		{name: "pull request", req: &v1.SnoozeThreadRequest{Id: "s-1", Event: &v1.SnoozeEvent{PullRequest: "acme/web#812", Condition: "merged"}},
			wantCall: "SnoozeUntilEvent s-1 acme/web#812 merged",
			want:     &v1.ThreadSnoozeEvent{Kind: "pull_request", Target: "acme/web#812", Condition: "merged", Label: "#812 merged", WaitingFor: "#812 is merged"}},
		{name: "plugin", req: &v1.SnoozeThreadRequest{Id: "s-1", Event: &v1.SnoozeEvent{Plugin: "hello/tick", Args: map[string]string{"every": "1h"}}},
			wantCall: "SnoozeUntilEvent s-1 hello/tick fired",
			want: &v1.ThreadSnoozeEvent{Kind: "plugin", Target: "hello/tick", Condition: "fired", Args: map[string]string{"every": "1h"},
				Label: "tick", WaitingFor: "tick (hello)"}},
		{name: "a thread asking it of itself", req: &v1.SnoozeThreadRequest{Id: "s-1", ByThreadId: "s-1", Event: &v1.SnoozeEvent{PullRequest: "#812"}},
			wantCall: "SnoozeUntilEvent s-1 #812 checks_done"},
		{name: "with until", req: &v1.SnoozeThreadRequest{Id: "s-1", Until: timestamppb.New(now.Add(time.Hour)), Event: &v1.SnoozeEvent{PullRequest: "#1"}},
			wantCode: connect.CodeInvalidArgument},
		{name: "with save", req: &v1.SnoozeThreadRequest{Id: "s-1", Save: true, Event: &v1.SnoozeEvent{PullRequest: "#1"}}, wantCode: connect.CodeInvalidArgument},
		{name: "neither", req: &v1.SnoozeThreadRequest{Id: "s-1", Event: &v1.SnoozeEvent{}}, wantCode: connect.CodeInvalidArgument,
			wantCall: "SnoozeUntilEvent s-1  checks_done"},
		{name: "unknown thread", req: &v1.SnoozeThreadRequest{Id: "nope", Event: &v1.SnoozeEvent{PullRequest: "#1"}}, wantCode: connect.CodeNotFound,
			wantCall: "SnoozeUntilEvent nope #1 checks_done"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fake, c := newThreadServer(t)
			fake.Now = func() time.Time { return now }
			fake.Put(thread.Thread{ID: "s-1", State: thread.StateConnected, CreatedAt: now})
			res, err := c.Snooze(context.Background(), connect.NewRequest(tt.req))
			if connect.CodeOf(err) != tt.wantCode && (tt.wantCode != 0 || err != nil) {
				t.Fatalf("Snooze = %v, want code %v", err, tt.wantCode)
			}
			if tt.wantCall != "" && !slices.Contains(fake.Calls(), tt.wantCall) {
				t.Errorf("calls = %q, want %q", fake.Calls(), tt.wantCall)
			}
			if err != nil || tt.want == nil {
				return
			}
			s := res.Msg.GetThread()
			ev := s.GetSnoozeEvent()
			if s.GetSavedAt() == nil || ev.GetKind() != tt.want.Kind || ev.GetTarget() != tt.want.Target || ev.GetCondition() != tt.want.Condition ||
				ev.GetLabel() != tt.want.Label || ev.GetWaitingFor() != tt.want.WaitingFor || !ev.GetSince().AsTime().Equal(now) ||
				len(ev.GetArgs()) != len(tt.want.Args) {
				t.Errorf("thread = saved %v, event %v; want %v", s.GetSavedAt(), ev, tt.want)
			}
		})
	}
}

func TestThreadSnoozeEndedBy(t *testing.T) {
	fake, c := newThreadServer(t)
	fake.Put(thread.Thread{ID: "s-1", Status: thread.StatusNeedsAttention, StatusReason: thread.ReasonSnoozeEnded, SnoozeEndedBy: "#812 was merged"})
	res, err := c.Get(context.Background(), connect.NewRequest(&v1.GetThreadRequest{Id: "s-1"}))
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Msg.GetThread(); got.GetSnoozeEndedBy() != "#812 was merged" || got.GetSnoozeEvent() != nil {
		t.Errorf("thread = %v", got)
	}
}

func TestThreadSnoozeEvents(t *testing.T) {
	fake, c := newThreadServer(t)
	fake.Put(thread.Thread{ID: "s-1"})
	fake.Events = thread.SnoozeEvents{
		PullRequests:  []thread.SnoozePullRequest{{Target: "acme/web#812", Number: 812, Title: "Fix login", Conditions: []thread.Condition{thread.CondChecksDone, thread.CondMerged}}},
		Plugins:       []thread.PluginSource{{Target: "hello/tick", Title: "Tick", PluginName: "Hello", Args: map[string]string{"every": "10s"}}},
		RecentPlugins: []string{"hello/tick"},
	}
	res, err := c.SnoozeEvents(context.Background(), connect.NewRequest(&v1.SnoozeEventsRequest{Id: "s-1"}))
	if err != nil {
		t.Fatal(err)
	}
	m := res.Msg
	if len(m.GetPullRequests()) != 1 || !slices.Equal(m.GetPullRequests()[0].GetConditions(), []string{"checks_done", "merged"}) ||
		m.GetPullRequests()[0].GetNumber() != 812 || len(m.GetPlugins()) != 1 || m.GetPlugins()[0].GetArgs()["every"] != "10s" ||
		m.GetPlugins()[0].GetPluginName() != "Hello" || !slices.Equal(m.GetRecentPlugins(), []string{"hello/tick"}) {
		t.Errorf("events = %v", m)
	}
	if _, err := c.SnoozeEvents(context.Background(), connect.NewRequest(&v1.SnoozeEventsRequest{Id: "nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown: %v", err)
	}
}
