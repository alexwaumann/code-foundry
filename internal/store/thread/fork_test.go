package thread

import (
	"context"
	"reflect"
	"slices"
	"testing"
	"time"
)

func TestForkItems(t *testing.T) {
	at := time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)
	now := at.Add(time.Hour)
	note := Item{ID: "note-fork-p", Kind: KindNote, Text: "Forked from base", CreatedAt: now, UpdatedAt: now}
	createdBy := Item{ID: createdByNoteID, Ordinal: 1, Kind: KindNote, Text: "Created by Parent", NoteCreatedBy: "s-parent", CreatedAt: at, UpdatedAt: at}
	user := Item{ID: "u", Ordinal: 3, Kind: KindUserMessage, Text: "hi", CreatedAt: at, UpdatedAt: at}
	text := Item{ID: "m/0", Ordinal: 4, Kind: KindAssistantText, Text: "hello", CreatedAt: at, UpdatedAt: at}
	end := Item{ID: "turn-1", Ordinal: 5, Kind: KindTurnEnd, Turn: &TurnEnd{Subtype: "success", CostUSD: 0.5, TurnCostUSD: new(0.5)}, CreatedAt: at, UpdatedAt: at}
	sub := Item{ID: "sub/0", Ordinal: 9, Kind: KindAssistantText, Text: "from the agent", ParentToolUseID: "agent", CreatedAt: at, UpdatedAt: at}
	running := Item{ID: "tu", Ordinal: 6, Kind: KindToolCall, Tool: &ToolCall{ToolUseID: "tu", Name: "Bash", Status: ToolRunning}}
	ranOut := Item{ID: "tu2", Ordinal: 7, Kind: KindToolCall, Tool: &ToolCall{ToolUseID: "tu2", Name: "Bash", Status: ToolRunning, Output: "half"}}
	pending := Item{ID: "perm-r", Ordinal: 8, Kind: KindPermission, Request: &Request{RequestID: "r", ToolName: "Bash", State: RequestPending}}
	question := Item{ID: "q-r2", Ordinal: 10, Kind: KindQuestion, Request: &Request{RequestID: "r2", State: RequestPending}}
	answered := Item{ID: "perm-r3", Ordinal: 11, Kind: KindPermission, Request: &Request{RequestID: "r3", State: RequestAllowed, Decision: DecisionAllow}}
	streaming := Item{ID: "m2/0", Ordinal: 12, Kind: KindAssistantText, Text: "half a th", Streaming: true}

	renumbered := func(it Item, ord int64) Item { it = cloneItem(it); it.Ordinal = ord; return it }
	noteAt := func(ord int64) Item { n := note; n.Ordinal = ord; return n }
	tests := []struct {
		name   string
		parent []Item
		want   []Item
	}{
		{"a parent with no items: just the note", nil, []Item{noteAt(1)}},
		{"a finished turn is copied as is, renumbered, times kept", []Item{user, text, end},
			[]Item{renumbered(user, 1), renumbered(text, 2), renumbered(end, 3), noteAt(4)}},
		{"subagent items keep their parent", []Item{sub}, []Item{renumbered(sub, 1), noteAt(2)}},
		{"a created-by note keeps its creator", []Item{createdBy, user}, []Item{renumbered(createdBy, 1), renumbered(user, 2), noteAt(3)}},
		{"running tools end as errors", []Item{running, ranOut}, []Item{
			func() Item {
				it := renumbered(running, 1)
				it.Tool.Status, it.Tool.Output = ToolError, "Interrupted: "+forkWhy+"."
				return it
			}(),
			func() Item { it := renumbered(ranOut, 2); it.Tool.Status = ToolError; return it }(),
			noteAt(3),
		}},
		{"pending requests are cancelled, resolved ones kept", []Item{pending, question, answered}, []Item{
			func() Item {
				it := renumbered(pending, 1)
				it.Request.State, it.Request.Message = RequestCancelled, forkWhy
				return it
			}(),
			func() Item {
				it := renumbered(question, 2)
				it.Request.State, it.Request.Message = RequestCancelled, forkWhy
				return it
			}(),
			renumbered(answered, 3),
			noteAt(4),
		}},
		{"streaming items are dropped", []Item{user, streaming, end}, []Item{renumbered(user, 1), renumbered(end, 2), noteAt(3)}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var before []Item
			for _, it := range tt.parent {
				before = append(before, cloneItem(it))
			}
			got := forkItems(tt.parent, note.ID, note.Text, now)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got\n%s\nwant\n%s", describeItems(got), describeItems(tt.want))
			}
			if !reflect.DeepEqual(tt.parent, before) {
				t.Errorf("the parent's items changed:\n%s", describeItems(tt.parent))
			}
			if p := pendingOf(got); len(p) != 0 {
				t.Errorf("fork has pending requests %+v", p)
			}
		})
	}
}

func TestForkNoteText(t *testing.T) {
	for _, tt := range []struct {
		parent Thread
		want   string
	}{
		{Thread{ID: "s-1", Name: "fix-badge"}, "Forked from fix-badge"},
		{Thread{ID: "s-1"}, "Forked from s-1"},
	} {
		if got := forkNoteText(tt.parent); got != tt.want {
			t.Errorf("forkNoteText(%+v) = %q; want %q", tt.parent, got, tt.want)
		}
	}
}

// putItems adds items to a thread's log and database, as its runner would.
func (e *env) putItems(id string, items ...Item) {
	e.t.Helper()
	log, err := e.m.thread(e.ctx(), id)
	if err != nil {
		e.t.Fatal(err)
	}
	w := itemWriter{log: log, save: func(it Item) { e.m.saveItem(id, it) }}
	for _, it := range items {
		w.add(it)
	}
}

// resumable gives a thread a transcript, so it can be forked.
func (e *env) resumable(id string) {
	e.t.Helper()
	cid := argOf(e.spec(id).Argv, "--session-id")
	e.writeTranscript(cid, userLine("hi"))
	e.waitFor(id, "discovered", func(s Thread) bool { return s.ClaudeSessionID == cid })
}

// history is a thread's items without what changes in a copy (ordinal) or is the
// fork's own (times of the note).
func history(items []Item) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = string(it.Kind) + " " + it.ID + " " + it.Text
		if it.Request != nil {
			out[i] += " " + string(it.Request.State)
		}
	}
	return out
}

func TestForkCopiesItems(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "base"})
	e.resumable(s.ID)
	e.putItems(s.ID,
		Item{ID: "u1", Kind: KindUserMessage, Text: "hi"},
		Item{ID: "m1/0", Kind: KindAssistantText, Text: "hello"},
		Item{ID: "turn-1", Kind: KindTurnEnd, Turn: &TurnEnd{Subtype: "success", CostUSD: 0.25, TurnCostUSD: new(0.25)}},
		Item{ID: "u2", Kind: KindUserMessage, Text: "push it"},
		Item{ID: "perm-r1", Kind: KindPermission, Request: &Request{RequestID: "r1", ToolName: "Bash", State: RequestPending}},
	)
	parent := e.items(s.ID)
	if len(parent.Pending) != 1 {
		t.Fatalf("parent pending = %+v", parent.Pending)
	}

	f, err := e.m.Fork(e.ctx(), s.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	// The first Watch, right away, has the copy.
	ctx, cancel := context.WithCancel(e.ctx())
	defer cancel()
	snap, err := e.m.WatchItems(ctx, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"user_message u1 hi", "assistant_text m1/0 hello", "turn_end turn-1 ", "user_message u2 push it",
		"permission_request perm-r1  cancelled", "note note-fork-" + s.ID + " Forked from base"}
	if got := history(snap.Items); !slices.Equal(got, want) {
		t.Fatalf("fork items = %q; want %q", got, want)
	}
	if len(snap.Pending) != 0 {
		t.Errorf("fork pending = %+v; want none", snap.Pending)
	}
	for i, it := range snap.Items {
		if it.Ordinal != int64(i+1) {
			t.Errorf("item %d ordinal %d", i, it.Ordinal)
		}
	}
	for i, it := range parent.Items {
		if c := snap.Items[i]; !c.CreatedAt.Equal(it.CreatedAt) {
			t.Errorf("item %s created %v; parent's %v", it.ID, c.CreatedAt, it.CreatedAt)
		}
	}
	// The parent is untouched: its request still waits.
	if p := e.items(s.ID); len(p.Pending) != 1 || len(p.Items) != len(parent.Items) {
		t.Errorf("parent after fork: %d items, pending %+v", len(p.Items), p.Pending)
	}
	e.waitFor(f.ID, "fork connected", func(s Thread) bool { return s.State == StateConnected })

	// Renaming the parent later does not change the note; the rows survive a restart.
	if _, err := e.m.Rename(e.ctx(), s.ID, "renamed"); err != nil {
		t.Fatal(err)
	}
	e.restart()
	if got := history(e.items(f.ID).Items); !slices.Equal(got, want) {
		t.Errorf("fork items after restart = %q; want %q", got, want)
	}
}

func TestForkOfAFork(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "base"})
	e.resumable(s.ID)
	e.putItems(s.ID, Item{ID: "u1", Kind: KindUserMessage, Text: "one"}, Item{ID: "turn-1", Kind: KindTurnEnd, Turn: &TurnEnd{Subtype: "success"}})
	f, err := e.m.Fork(e.ctx(), s.ID, "first")
	if err != nil {
		t.Fatal(err)
	}
	e.waitFor(f.ID, "fork connected", func(s Thread) bool { return s.State == StateConnected })
	e.resumable(f.ID)
	e.putItems(f.ID, Item{ID: "u2", Kind: KindUserMessage, Text: "two"}, Item{ID: "turn-2", Kind: KindTurnEnd, Turn: &TurnEnd{Subtype: "success"}})
	// The parent goes away: the fork's copy and note stay.
	if err := e.m.Remove(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}

	g, err := e.m.Fork(e.ctx(), f.ID, "second")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"user_message u1 one", "turn_end turn-1 ", "note note-fork-" + s.ID + " Forked from base",
		"user_message u2 two", "turn_end turn-2 ", "note note-fork-" + f.ID + " Forked from first"}
	if got := history(e.items(g.ID).Items); !slices.Equal(got, want) {
		t.Errorf("fork of a fork = %q; want %q", got, want)
	}
}

func TestForkOfAThreadWithoutItems(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "empty"})
	e.resumable(s.ID)
	f, err := e.m.Fork(e.ctx(), s.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"note note-fork-" + s.ID + " Forked from empty"}
	if got := history(e.items(f.ID).Items); !slices.Equal(got, want) {
		t.Errorf("fork items = %q; want %q", got, want)
	}
	e.waitFor(f.ID, "fork connected", func(s Thread) bool { return s.State == StateConnected })
}
