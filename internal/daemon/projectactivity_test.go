package daemon

import (
	"context"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestLiveWorktrees(t *testing.T) {
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name    string
		threads []thread.Thread
		want    []string
	}{
		{name: "none", want: []string{}},
		{name: "live, distinct and sorted", threads: []thread.Thread{
			{ID: "a", ProjectID: "p", WorktreePath: "/w/b"},
			{ID: "b", ProjectID: "p", WorktreePath: "/w/a"},
			{ID: "c", ProjectID: "p", WorktreePath: "/w/b"},
		}, want: []string{"/w/a", "/w/b"}},
		{name: "archived", threads: []thread.Thread{
			{ID: "a", ProjectID: "p", WorktreePath: "/w/a", ArchivedAt: now.Add(-time.Hour)},
		}, want: []string{}},
		{name: "snoozed", threads: []thread.Thread{
			{ID: "a", ProjectID: "p", WorktreePath: "/w/a", SnoozedUntil: now.Add(time.Hour)},
		}, want: []string{}},
		{name: "snooze past", threads: []thread.Thread{
			{ID: "a", ProjectID: "p", WorktreePath: "/w/a", SnoozedUntil: now.Add(-time.Second)},
		}, want: []string{"/w/a"}},
		{name: "one live thread keeps a worktree live", threads: []thread.Thread{
			{ID: "a", ProjectID: "p", WorktreePath: "/w/a", ArchivedAt: now},
			{ID: "b", ProjectID: "p", WorktreePath: "/w/a"},
		}, want: []string{"/w/a"}},
		{name: "no project", threads: []thread.Thread{
			{ID: "a", WorktreePath: "/Users/me"},
		}, want: []string{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := liveWorktrees(&thread.Snapshot{Threads: tt.threads}, now)
			if !slices.Equal(got, tt.want) {
				t.Fatalf("live = %v, want %v", got, tt.want)
			}
		})
	}
	if got := liveWorktrees(nil, now); got == nil || len(got) != 0 {
		t.Fatalf("nil snapshot = %#v", got)
	}
}

func TestTouchFor(t *testing.T) {
	tool := func(name string, st thread.ToolStatus) thread.Item {
		return thread.Item{Kind: thread.KindToolCall, Tool: &thread.ToolCall{Name: name, Status: st}}
	}
	tests := []struct {
		name    string
		ev      thread.ThreadEvent
		ok, now bool
	}{
		{name: "edit result", ev: thread.ItemUpdated{Item: tool("Edit", thread.ToolDone)}, ok: true},
		{name: "write result", ev: thread.ItemUpdated{Item: tool("Write", thread.ToolDone)}, ok: true},
		{name: "multiedit result", ev: thread.ItemUpdated{Item: tool("MultiEdit", thread.ToolDone)}, ok: true},
		{name: "notebook edit result", ev: thread.ItemUpdated{Item: tool("NotebookEdit", thread.ToolDone)}, ok: true},
		{name: "bash error", ev: thread.ItemUpdated{Item: tool("Bash", thread.ToolError)}, ok: true},
		{name: "appended done", ev: thread.ItemAppended{Item: tool("Edit", thread.ToolDone)}, ok: true},
		{name: "edit still running", ev: thread.ItemUpdated{Item: tool("Edit", thread.ToolRunning)}},
		{name: "edit appended running", ev: thread.ItemAppended{Item: tool("Edit", thread.ToolRunning)}},
		{name: "read result", ev: thread.ItemUpdated{Item: tool("Read", thread.ToolDone)}},
		{name: "tool without payload", ev: thread.ItemUpdated{Item: thread.Item{Kind: thread.KindToolCall}}},
		{name: "turn end", ev: thread.ItemAppended{Item: thread.Item{Kind: thread.KindTurnEnd}}, ok: true, now: true},
		{name: "assistant text", ev: thread.ItemAppended{Item: thread.Item{Kind: thread.KindAssistantText}}},
		{name: "delta", ev: thread.ItemDelta{Field: thread.DeltaText, Text: "x"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			now, ok := touchFor(tt.ev)
			if ok != tt.ok || now != tt.now {
				t.Fatalf("touchFor = (now %v, ok %v), want (now %v, ok %v)", now, ok, tt.now, tt.ok)
			}
		})
	}
}

func TestProjectActivity(t *testing.T) {
	b := bus.New()
	rec := &recordingActivity{}
	var snap atomic.Pointer[thread.Snapshot]
	snap.Store(&thread.Snapshot{Threads: []thread.Thread{
		{ID: "t1", ProjectID: "p", WorktreePath: "/w/a"},
		{ID: "t2", WorktreePath: "/Users/me"},
	}})
	stop := startProjectActivity(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)), snap.Load, rec, b)
	defer stop()
	waitCalls := func(want ...string) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for !slices.Equal(rec.got(), want) {
			if time.Now().After(deadline) {
				t.Fatalf("calls = %q, want %q", rec.got(), want)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	waitCalls("live /w/a")

	// An unrelated update changes nothing; archiving the thread empties the set.
	bus.Publish[thread.Event](b, thread.Updated{Thread: thread.Thread{ID: "t2"}})
	th := snap.Load().Threads[0]
	th.ArchivedAt = time.Now()
	snap.Store(&thread.Snapshot{Threads: []thread.Thread{th}})
	bus.Publish[thread.Event](b, thread.Updated{Thread: th})
	waitCalls("live /w/a", "live ")

	// Items: an edit's result is a debounced touch, a turn end an immediate one; a
	// thread without a project and an unknown thread touch nothing.
	snap.Store(&thread.Snapshot{Threads: []thread.Thread{
		{ID: "t1", ProjectID: "p", WorktreePath: "/w/a"},
		{ID: "t2", WorktreePath: "/Users/me"},
	}})
	edit := thread.Item{Kind: thread.KindToolCall, Tool: &thread.ToolCall{Name: "Edit", Status: thread.ToolDone}}
	bus.Publish[thread.ThreadEvent](b, thread.ItemUpdated{ThreadID: "t2", Item: edit})
	bus.Publish[thread.ThreadEvent](b, thread.ItemUpdated{ThreadID: "gone", Item: edit})
	bus.Publish[thread.ThreadEvent](b, thread.ItemUpdated{ThreadID: "t1", Item: edit})
	bus.Publish[thread.ThreadEvent](b, thread.ItemAppended{ThreadID: "t1", Item: thread.Item{Kind: thread.KindTurnEnd}})
	waitCalls("live /w/a", "live ", "touch /w/a", "now /w/a")
}

type recordingActivity struct {
	mu    sync.Mutex
	calls []string
}

func (r *recordingActivity) record(c string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, c)
}

func (r *recordingActivity) SetLiveWorktrees(paths []string) {
	r.record("live " + strings.Join(paths, ","))
}
func (r *recordingActivity) Touch(path string)    { r.record("touch " + path) }
func (r *recordingActivity) TouchNow(path string) { r.record("now " + path) }

func (r *recordingActivity) got() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.calls)
}
