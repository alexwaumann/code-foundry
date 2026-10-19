package thread

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestTombstonesExpire(t *testing.T) {
	at := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	var ts tombstones
	ts.add(RemovedThread{ID: "s-old", RemovedAt: at})
	ts.add(RemovedThread{ID: "s-new", RemovedAt: at.Add(time.Hour)})
	tests := []struct {
		name string
		id   string
		now  time.Time
		want bool
	}{
		{"just removed", "s-old", at, true},
		{"a moment before the TTL", "s-old", at.Add(RemovedTTL - time.Second), true},
		{"at the TTL", "s-old", at.Add(RemovedTTL), false},
		{"another, removed later", "s-new", at.Add(RemovedTTL), true},
		{"never removed", "s-x", at, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, ok := ts.get(tt.id, tt.now); ok != tt.want {
				t.Errorf("get(%s) = %v, want %v", tt.id, ok, tt.want)
			}
		})
	}
	if got := ts.list(at.Add(RemovedTTL)); len(got) != 1 || got[0].ID != "s-new" {
		t.Errorf("list after the first expired = %+v", got)
	}
	if _, kept := ts.byID["s-old"]; kept {
		t.Error("list did not prune the expired tombstone")
	}
}

func TestFilterRemoved(t *testing.T) {
	at := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	removed := []RemovedThread{
		{ID: "s-a", CreatedBy: "s-p", Labels: []string{"bug", "ui"}, ProjectID: "r1", RemovedAt: at},
		{ID: "s-b", CreatedBy: "s-p", Labels: []string{"bug"}, ProjectID: "r2", RemovedAt: at.Add(time.Minute)},
		{ID: "s-c", RemovedAt: at.Add(2 * time.Minute)},
		{ID: "s-d", CreatedBy: "s-p", Owner: "plugin:hello", RemovedAt: at.Add(3 * time.Minute)},
	}
	tests := []struct {
		name string
		o    ListOptions
		want []string
	}{
		{"everything not owned, newest first", ListOptions{}, []string{"s-c", "s-b", "s-a"}},
		{"created by a thread", ListOptions{CreatedBy: "s-p"}, []string{"s-b", "s-a"}},
		{"created by the user", ListOptions{CreatedBy: CreatedByUser}, []string{"s-c"}},
		{"labels", ListOptions{Labels: []string{"bug", "ui"}}, []string{"s-a"}},
		{"project", ListOptions{Project: "r2"}, []string{"s-b"}},
		{"owned", ListOptions{Owner: "plugin:"}, []string{"s-d"}},
		{"all includes owned", ListOptions{All: true}, []string{"s-d", "s-c", "s-b", "s-a"}},
		{"a status leaves them out", ListOptions{Status: StatusIdle}, nil},
		{"a state leaves them out", ListOptions{State: StateDisconnected}, nil},
		{"limit", ListOptions{Limit: 1}, []string{"s-c"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []string
			for _, r := range FilterRemoved(removed, tt.o) {
				got = append(got, r.ID)
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("FilterRemoved = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestRemovedWakeMessage(t *testing.T) {
	at := time.Date(2026, 10, 19, 12, 0, 0, 5e6, time.UTC)
	tests := []struct {
		name      string
		r         RemovedThread
		wantTitle string
		wantJSON  []string
	}{
		{
			name: "named, with a report",
			r: RemovedThread{ID: "s-c", Name: "Add persistence", ProjectID: "r1", CreatedBy: "s-p", Labels: []string{"e4"}, RemovedAt: at,
				Report: Report{Status: ReportDone, Summary: "c6b0cb6", Data: `{"n":1}`, At: at}},
			wantTitle: `Thread "Add persistence" (s-c) was removed.`,
			wantJSON: []string{`"condition": "removed"`, `"subscription_id": "sub-1"`, `"removed_at": "2026-10-19T12:00:00.005Z"`,
				`"created_by": "s-p"`, `"summary": "c6b0cb6"`, `"n": 1`, `"labels": [`},
		},
		{
			name: "unnamed, no report", r: RemovedThread{ID: "s-x", RemovedAt: at},
			wantTitle: "Thread s-x was removed.",
			wantJSON:  []string{`"condition": "removed"`, `"labels": []`, `"report": null`},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg := removedWake(Subscription{ID: "sub-1", Condition: CondSettled}, tt.r, at)
			if msg.WakeTitle != tt.wantTitle || msg.Origin != OriginWake || !strings.HasPrefix(msg.Text, wakePrefix+tt.wantTitle+"\n```json\n") {
				t.Errorf("title = %q, text = %q", msg.WakeTitle, msg.Text)
			}
			for _, key := range tt.wantJSON {
				if !strings.Contains(msg.WakeJSON, key) {
					t.Errorf("JSON lacks %s:\n%s", key, msg.WakeJSON)
				}
			}
		})
	}
}

// Removing a thread tells its subscribers once each, with the removed wake and not the
// closing snapshot's, and leaves a tombstone its id is looked up in.
func TestRemoveLeavesTombstone(t *testing.T) {
	e := newEnv(t)
	parent, other := e.stopped("parent"), e.stopped("other")
	child := e.connected(CreateOptions{Name: "child", CreatedBy: parent.ID, Labels: []string{"e4"}})
	if _, err := e.m.Report(e.ctx(), child.ID, Report{Status: ReportDone, Summary: "all good"}); err != nil {
		t.Fatal(err)
	}
	// A running child is neither disconnected nor in error: nothing fires before the
	// removal, and the removal's own close (closing, then disconnected) must not either.
	for _, o := range []SubscribeOptions{
		{SubscriberID: parent.ID, TargetThreadID: child.ID, Condition: CondDisconnected, Repeat: true},
		{SubscriberID: parent.ID, TargetThreadID: child.ID, Condition: CondError},
		{SubscriberID: other.ID, TargetThreadID: child.ID, Condition: CondDisconnected},
	} {
		if res, err := e.m.Subscribe(e.ctx(), o); err != nil || res.Fired {
			t.Fatalf("Subscribe = %+v, %v", res, err)
		}
	}
	if err := e.m.Remove(e.ctx(), child.ID); err != nil {
		t.Fatal(err)
	}
	wantTitle := `Thread "child" (` + child.ID + `) was removed.`
	for _, sub := range []Thread{parent, other} {
		items := e.waitItems(sub.ID, "the removed wake", func(items []Item) bool { return len(wakes(items)) > 0 })
		w := wakes(items)
		if len(w) != 1 || w[0].WakeTitle != wantTitle || !strings.Contains(w[0].WakeJSON, `"condition": "removed"`) ||
			!strings.Contains(w[0].WakeJSON, `"summary": "all good"`) {
			t.Errorf("wakes of %s = %+v", sub.Name, w)
		}
	}
	time.Sleep(50 * time.Millisecond) // a late second wake would show by now
	if n := len(wakes(e.items(parent.ID).Items)); n != 1 {
		t.Errorf("parent got %d wakes, want 1", n)
	}
	if subs, _ := e.m.Subscriptions(e.ctx(), ""); len(subs) != 0 {
		t.Errorf("subscriptions left: %+v", subs)
	}

	_, err := e.m.Get(e.ctx(), child.ID)
	var re *RemovedError
	if !errors.As(err, &re) || !errors.Is(err, ErrNotFound) || re.Thread.Name != "child" || re.Thread.CreatedBy != parent.ID ||
		re.Thread.Report.Summary != "all good" || re.Thread.RemovedAt.IsZero() || !strings.Contains(err.Error(), "was removed at") {
		t.Errorf("Get = %v (%+v)", err, re)
	}
	if _, err := e.m.Send(e.ctx(), child.ID, Message{Text: "hi"}); !errors.As(err, &re) {
		t.Errorf("Send = %v, want a RemovedError", err)
	}
	if _, err := e.m.Get(e.ctx(), "s-000000000000"); err == nil || errors.As(err, &re) {
		t.Errorf("Get of an unknown id = %v, want a plain not found", err)
	}
	for _, tt := range []struct {
		by   string
		want int
	}{{parent.ID, 1}, {other.ID, 0}} {
		if got, err := e.m.ListRemoved(e.ctx(), ListOptions{CreatedBy: tt.by}); err != nil || len(got) != tt.want {
			t.Errorf("ListRemoved(created by %s) = %+v, %v; want %d", tt.by, got, err, tt.want)
		}
	}
}

// A removal that fails leaves the thread as it was, no longer Removing.
func TestRemoveFailsClearsRemoving(t *testing.T) {
	e := newEnv(t)
	child := e.connected(CreateOptions{Name: "child"})
	ctx, cancel := context.WithCancel(e.ctx())
	cancel() // Close gives up at once
	if err := e.m.Remove(ctx, child.ID); err == nil {
		t.Fatal("Remove with a cancelled context succeeded")
	}
	s := e.waitFor(child.ID, "not removing", func(s Thread) bool { return !s.Removing })
	if _, gone := e.m.Removed(child.ID); gone || !Meets(CondSettled, s) {
		t.Errorf("after a failed removal: %+v (tombstone %v)", s, gone)
	}
}
