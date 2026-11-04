package search

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
)

// What the row reads from a history: the running count and newest, and the unseen one
// that finished last, whichever started first.
func TestActivity(t *testing.T) {
	t0 := time.UnixMilli(1_000_000)
	at := func(s int) time.Time { return t0.Add(time.Duration(s) * time.Second) }
	hits := func(threads ...string) []Hit {
		var out []Hit
		for i, th := range threads {
			out = append(out, Hit{N: i + 1, ThreadID: th})
		}
		return out
	}
	tests := []struct {
		name    string
		entries []Entry
		want    Activity
	}{
		{name: "empty"},
		{name: "a find entry is nothing", entries: []Entry{{ID: "q-f", Mode: ModeFind, CreatedAt: at(1)}}},
		{
			name: "seen and stopped are nothing",
			entries: []Entry{
				{ID: "q-a", Mode: ModeAgent, CreatedAt: at(1), Status: StatusDone, FinishedAt: at(2)},
				{ID: "q-b", Mode: ModeAgent, CreatedAt: at(3), Status: StatusStopped, FinishedAt: at(4)},
			},
		},
		{
			name:    "one running",
			entries: []Entry{{ID: "q-a", Mode: ModeAgent, CreatedAt: at(1), Status: StatusRunning}},
			want:    Activity{Running: 1, RunningID: "q-a"},
		},
		{
			name: "two running: the newest",
			entries: []Entry{
				{ID: "q-a", Mode: ModeAgent, CreatedAt: at(1), Status: StatusRunning},
				{ID: "q-b", Mode: ModeAgent, CreatedAt: at(2), Status: StatusRunning},
			},
			want: Activity{Running: 2, RunningID: "q-b"},
		},
		{
			name:    "unseen with its hits",
			entries: []Entry{{ID: "q-a", Mode: ModeAgent, CreatedAt: at(1), Status: StatusDone, FinishedAt: at(2), Unseen: true, Hits: hits("s-aaa", "s-bbb")}},
			want:    Activity{UnseenID: "q-a", UnseenStatus: StatusDone, UnseenHits: 2},
		},
		{
			name:    "a hit in a removed thread is not counted",
			entries: []Entry{{ID: "q-a", Mode: ModeAgent, CreatedAt: at(1), Status: StatusDone, FinishedAt: at(2), Unseen: true, Hits: hits("s-aaa", "s-gone")}},
			want:    Activity{UnseenID: "q-a", UnseenStatus: StatusDone, UnseenHits: 1},
		},
		{
			name:    "failed",
			entries: []Entry{{ID: "q-a", Mode: ModeAgent, CreatedAt: at(1), Status: StatusFailed, FinishedAt: at(2), Unseen: true}},
			want:    Activity{UnseenID: "q-a", UnseenStatus: StatusFailed},
		},
		{
			name: "the one that finished last, not the one that started last",
			entries: []Entry{
				{ID: "q-a", Mode: ModeAgent, CreatedAt: at(1), Status: StatusDone, FinishedAt: at(9), Unseen: true, Hits: hits("s-aaa")},
				{ID: "q-b", Mode: ModeAgent, CreatedAt: at(2), Status: StatusFailed, FinishedAt: at(5), Unseen: true},
			},
			want: Activity{UnseenID: "q-a", UnseenStatus: StatusDone, UnseenHits: 1},
		},
		{
			name: "finished together: the newer search",
			entries: []Entry{
				{ID: "q-a", Mode: ModeAgent, CreatedAt: at(1), Status: StatusDone, FinishedAt: at(9), Unseen: true},
				{ID: "q-b", Mode: ModeAgent, CreatedAt: at(2), Status: StatusDone, FinishedAt: at(9), Unseen: true},
			},
			want: Activity{UnseenID: "q-b", UnseenStatus: StatusDone},
		},
		{
			name: "running and unseen both say",
			entries: []Entry{
				{ID: "q-a", Mode: ModeAgent, CreatedAt: at(1), Status: StatusDone, FinishedAt: at(2), Unseen: true},
				{ID: "q-b", Mode: ModeAgent, CreatedAt: at(3), Status: StatusRunning},
			},
			want: Activity{Running: 1, RunningID: "q-b", UnseenID: "q-a", UnseenStatus: StatusDone},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, "agent.jsonl", Options{})
			h.s.mu.Lock()
			for i := range tt.entries {
				h.s.entries[tt.entries[i].ID] = &tt.entries[i]
			}
			h.s.mu.Unlock()
			if got := h.s.Activity(); got != tt.want {
				t.Errorf("Activity() = %+v, want %+v", got, tt.want)
			}
			h.s.mu.Lock()
			clear(h.s.entries)
			h.s.mu.Unlock()
		})
	}
}

// activities drains what has been published.
func activities(sub *bus.Subscription[Activity]) []Activity {
	var out []Activity
	for len(sub.C()) > 0 {
		out = append(out, <-sub.C())
	}
	return out
}

// A run publishes its start and its end and nothing between: its steps and hits are not
// activity. Seen clears it, and doing it again publishes nothing.
func TestActivityPublishedOnChangeOnly(t *testing.T) {
	gate := filepath.Join(t.TempDir(), "go")
	h := newHarness(t, "agent.jsonl", Options{}, "CF_FAKE_CLAUDE_INIT_GATE="+gate)
	ctx := context.Background()
	sub := bus.Subscribe[Activity](h.bus, 64)
	defer sub.Close()
	e, err := h.s.StartAgent(ctx, "q")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.s.Report(ctx, e.ID, "s-aaa", "#4", "a quote from s-aaa", "why"); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(gate, nil, 0o600)
	h.wait(t, e.ID)
	hits := len(mustGet(t, h, e.ID).Hits)
	got := activities(sub)
	want := []Activity{{Running: 1, RunningID: e.ID}, {UnseenID: e.ID, UnseenStatus: StatusDone, UnseenHits: hits}}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("published %+v, want %+v", got, want)
	}
	if _, err := h.s.OpenHit(ctx, e.ID, 1); err != nil {
		t.Fatal(err)
	}
	if got := activities(sub); len(got) != 0 {
		t.Errorf("an opened hit published %+v", got)
	}
	for range 2 {
		if _, err := h.s.MarkSeen(ctx, e.ID); err != nil {
			t.Fatal(err)
		}
	}
	if got := activities(sub); len(got) != 1 || got[0] != (Activity{}) {
		t.Errorf("after seen = %+v, want one empty", got)
	}
}

func mustGet(t *testing.T, h *harness, id string) Entry {
	t.Helper()
	e, err := h.s.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

// Each way an unseen search goes away ends the activity: forgotten, cleared, promoted.
func TestActivityClearsWithTheEntry(t *testing.T) {
	tests := []struct {
		name string
		do   func(ctx context.Context, h *harness, id string) error
	}{
		{"forget", func(ctx context.Context, h *harness, id string) error { return h.s.Forget(ctx, id) }},
		{"clear", func(ctx context.Context, h *harness, _ string) error { _, err := h.s.Clear(ctx); return err }},
		{"promote", func(ctx context.Context, h *harness, id string) error { _, err := h.s.Promote(ctx, id); return err }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, "agent.jsonl", Options{})
			ctx := context.Background()
			e, err := h.s.StartAgent(ctx, "q")
			if err != nil {
				t.Fatal(err)
			}
			h.wait(t, e.ID)
			if a := h.s.Activity(); a.UnseenID != e.ID {
				t.Fatalf("before = %+v", a)
			}
			sub := bus.Subscribe[Activity](h.bus, 64)
			defer sub.Close()
			if err := tt.do(ctx, h, e.ID); err != nil {
				t.Fatal(err)
			}
			if got := activities(sub); len(got) != 1 || got[0] != (Activity{}) {
				t.Errorf("published %+v, want one empty", got)
			}
		})
	}
}

// A search the user stops leaves nothing, and neither does one forgotten as it runs.
func TestActivityStoppedRun(t *testing.T) {
	tests := []struct {
		name string
		do   func(ctx context.Context, h *harness, id string) error
	}{
		{"stop", func(ctx context.Context, h *harness, id string) error { _, err := h.s.Stop(ctx, id); return err }},
		{"forget", func(ctx context.Context, h *harness, id string) error { return h.s.Forget(ctx, id) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, "agent.jsonl", Options{}, "CF_FAKE_CLAUDE_STALL=1")
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			e, err := h.s.StartAgent(ctx, "q")
			if err != nil {
				t.Fatal(err)
			}
			if a := h.s.Activity(); a.Running != 1 || a.RunningID != e.ID {
				t.Fatalf("running = %+v", a)
			}
			if err := tt.do(ctx, h, e.ID); err != nil {
				t.Fatal(err)
			}
			if a := h.s.Activity(); a != (Activity{}) {
				t.Errorf("after = %+v, want nothing", a)
			}
		})
	}
}

// A run the last daemon left behind: not running in the next one's first activity, but
// unseen and failed, so a client's stale "running" is replaced by the words for it.
func TestActivityAfterARestart(t *testing.T) {
	db := dbtest.Open(t)
	if err := saveEntry(context.Background(), db, Entry{ID: "q-1", Mode: ModeAgent, Query: "q", CreatedAt: time.Now(), Status: StatusRunning}); err != nil {
		t.Fatal(err)
	}
	s, err := New(context.Background(), Options{DB: db, Threads: &fakeThreads{}})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := s.Activity(), (Activity{UnseenID: "q-1", UnseenStatus: StatusFailed}); got != want {
		t.Errorf("Activity() = %+v, want %+v", got, want)
	}
}
