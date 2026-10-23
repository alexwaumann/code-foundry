package thread

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// TestOpenTurn: which turn a log ends in without a turn end, and where it starts.
func TestOpenTurn(t *testing.T) {
	user := func(id string) Item { return Item{ID: id, Kind: KindUserMessage} }
	text := func(id string) Item { return Item{ID: id, Kind: KindAssistantText} }
	tool := func(id string) Item { return Item{ID: id, Kind: KindToolCall} }
	sub := func(id string) Item { return Item{ID: id, Kind: KindAssistantText, ParentToolUseID: "agent"} }
	end := func(id string) Item { return Item{ID: id, Kind: KindTurnEnd, Turn: &TurnEnd{Subtype: "success"}} }
	errItem := func(id string) Item { return Item{ID: id, Kind: KindError} }
	note := func(id string) Item { return Item{ID: id, Kind: KindNote} }
	page := func(id string) Item { return Item{ID: id, Kind: KindHTML, HTML: &HTMLPage{Path: "p.html"}} }
	card := func(id string) Item { return Item{ID: id, Kind: KindTheme, Theme: &ThemeCard{}} }
	cmdOut := func(id string) Item { return Item{ID: id, Kind: KindCommandOutput, Text: "Set effort to high"} }
	tests := []struct {
		name  string
		items []Item
		start string // "" when no turn is open
	}{
		{"no items", nil, ""},
		{"ended by a result", []Item{user("u"), text("a"), end("e")}, ""},
		{"ended by the daemon", []Item{user("u"), {ID: "s", Kind: KindTurnEnd, Turn: &TurnEnd{Subtype: SubtypeProcessEnded}}}, ""},
		{"a fork's copied history", []Item{user("u"), tool("t"), note("note-fork-p")}, ""},
		{"an error after the turn end", []Item{user("u"), end("e"), errItem("x")}, ""},
		{"a background agent's items after the turn end", []Item{user("u"), tool("agent"), end("e"), sub("s1"), note("n")}, ""},
		{"a subagent still talking after the turn end", []Item{user("u"), end("e"), sub("s1")}, ""},
		{"a message alone", []Item{user("u")}, "u"},
		{"mid-turn", []Item{user("u0"), end("e"), user("u"), text("a"), tool("t")}, "u"},
		{"a steer is part of the turn", []Item{user("u"), tool("t"), user("steer"), text("a")}, "u"},
		{"an error before the message", []Item{end("e"), errItem("x"), user("u"), tool("t")}, "u"},
		{"a turn Claude started itself", []Item{user("u"), end("e"), text("w"), tool("t")}, "w"},
		{"after a fork's note", []Item{user("u"), note("note-fork-p"), user("u2")}, "u2"},
		{"a message that failed to start", []Item{user("u"), errItem("x")}, "u"},
		{"a page shown between turns", []Item{user("u"), end("e"), page("p")}, ""},
		{"a page shown before any turn", []Item{page("p")}, ""},
		{"an effort restart between turns", []Item{user("u"), end("e"), cmdOut("effort-1")}, ""},
		{"a page, then a message", []Item{user("u"), end("e"), page("p"), user("u2"), tool("t")}, "u2"},
		{"a page inside the turn", []Item{user("u"), tool("t"), page("p")}, "u"},
		{"a theme card between turns", []Item{user("u"), end("e"), card("c")}, ""},
		{"a theme card inside the turn", []Item{user("u"), tool("t"), card("c")}, "u"},
		{"a page before Claude starts a turn itself", []Item{user("u"), end("e"), page("p"), text("w")}, "w"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			start, _, ok := openTurn(tt.items)
			if ok != (tt.start != "") || start.ID != tt.start {
				t.Errorf("openTurn = %q, %v; want %q", start.ID, ok, tt.start)
			}
		})
	}
}

// TestCloseOpenTurn: the turn end the daemon writes, once, persisted, and the cost seed
// of the next process skipping it.
func TestCloseOpenTurn(t *testing.T) {
	t0 := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	now := t0
	clock := func() time.Time { return now }
	log := newThreadLog("th", bus.New(), clock, nil)
	var saved []Item
	w := itemWriter{log: log, save: func(it Item) { saved = append(saved, it) }}

	if _, ok := closeOpenTurn(w, now); ok || len(saved) != 0 {
		t.Fatalf("closed a turn in an empty log: %+v", saved)
	}
	w.add(Item{ID: "u1", Kind: KindUserMessage, Text: "first"})
	w.add(Item{ID: "turn-1", Kind: KindTurnEnd, Turn: &TurnEnd{Subtype: "success", CostUSD: 0.5, ProcessOutputTokens: 100}})
	if _, ok := closeOpenTurn(w, now); ok {
		t.Fatal("closed a turn that ended")
	}
	now = t0.Add(time.Minute)
	w.add(Item{ID: "u2", Kind: KindUserMessage, Text: "second"})
	now = t0.Add(time.Minute + 2*time.Second)
	w.add(Item{ID: "tool", Kind: KindToolCall, Tool: &ToolCall{Name: "Bash", Status: ToolError}})
	now = t0.Add(time.Minute + 12500*time.Millisecond)
	n := len(saved)
	it, ok := closeOpenTurn(w, now)
	if !ok {
		t.Fatal("did not close the open turn")
	}
	want := TurnEnd{Subtype: SubtypeProcessEnded, Interrupted: true, DurationMS: 12500}
	if it.ID != "turn-synth-u2" || it.Kind != KindTurnEnd || it.Turn == nil || it.Turn.TurnCostUSD != nil ||
		it.Turn.Subtype != want.Subtype || it.Turn.Interrupted != want.Interrupted || it.Turn.DurationMS != want.DurationMS || it.Turn.CostUSD != 0 {
		t.Errorf("turn end = %+v %+v; want %+v", it, it.Turn, want)
	}
	if len(saved) != n+1 || saved[n].ID != it.ID {
		t.Errorf("not persisted: %+v", saved[n:])
	}
	if _, ok := closeOpenTurn(w, now); ok {
		t.Error("closed the same turn twice")
	}
	// The next process measures its first turn's cost from the last result, not from
	// the daemon's turn end (which has no totals).
	p := newProjector(w, runningTotals{known: true})
	if want := (runningTotals{known: true, cost: 0.5, out: 100}); p.costs.prev != want {
		t.Errorf("cost seed = %+v; want %+v", p.costs.prev, want)
	}
	// An end before the turn's start (clock skew) is a duration of 0, not negative.
	w.add(Item{ID: "u3", Kind: KindUserMessage})
	if it, _ := closeOpenTurn(w, t0); it.Turn.DurationMS != 0 {
		t.Errorf("duration %d; want 0", it.Turn.DurationMS)
	}
}

// TestProcessEndClosesTheTurn covers every way a live process ends: a turn that was
// running gets the daemon's turn end (the hang capture never sends a result), right
// after what the process left; a thread at its prompt gets nothing. The item is
// persisted: a restarted daemon reads it back.
func TestProcessEndClosesTheTurn(t *testing.T) {
	type end func(e *env, s Thread)
	exit := func(code int) end {
		return func(e *env, s Thread) { e.exit(s.ID, code) }
	}
	closeIt := func(e *env, s Thread) {
		if err := e.m.Close(context.Background(), s.ID); err != nil {
			e.t.Fatal(err)
		}
	}
	archive := func(e *env, s Thread) {
		if _, err := e.m.Archive(context.Background(), s.ID, true); err != nil {
			e.t.Fatal(err)
		}
	}
	shutdown := func(e *env, _ Thread) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := e.m.Shutdown(ctx); err != nil {
			e.t.Fatal(err)
		}
	}
	tests := []struct {
		name  string
		setup statusSetup
		end   end
		// synth: the daemon's turn end is the last item; else the turn ends are the
		// results' alone (turns of them).
		synth bool
		turns int
		// errText starts the error item before the turn end ("" for none).
		errText string
	}{
		{"exit while busy", busySetup, exit(0), true, 0, "Claude stopped unexpectedly (exit code 0"},
		{"crash while busy", busySetup, exit(1), true, 0, "Claude stopped unexpectedly (exit code 1"},
		{"killed while busy", busySetup, exit(-1), true, 0, "Claude stopped unexpectedly (killed"},
		{"closed while busy", busySetup, closeIt, true, 0, ""},
		{"archived while busy", busySetup, archive, true, 0, ""},
		{"daemon stopped while busy", busySetup, shutdown, true, 0, ""},
		{"exit idle without a turn", idleSetup, exit(0), false, 0, ""},
		{"exit after a turn", finishedSetup, exit(0), false, 1, ""},
		{"closed after a turn", finishedSetup, closeIt, false, 1, ""},
		{"daemon stopped after a turn", finishedSetup, shutdown, false, 1, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, s := tt.setup.start(t)
			before := e.items(s.ID).Items
			tt.end(e, s)
			e.waitFor(s.ID, "disconnected", func(s Thread) bool { return s.State == StateDisconnected })
			// What the database holds (a restarted daemon's timeline).
			items, err := loadItems(context.Background(), e.m.opts.DB, s.ID)
			if err != nil {
				t.Fatal(err)
			}
			var synth []Item
			results := 0
			for _, it := range items {
				switch {
				case it.Kind == KindTurnEnd && isSynthTurn(it.Turn):
					synth = append(synth, it)
				case it.Kind == KindTurnEnd:
					results++
				}
			}
			if !tt.synth {
				if len(synth) != 0 || results != tt.turns {
					t.Errorf("want %d turn ends from results and none of the daemon's:\n%s", tt.turns, describeItems(items))
				}
				return
			}
			if len(before) == 0 || before[0].Kind != KindUserMessage {
				t.Fatalf("setup left no message:\n%s", describeItems(before))
			}
			last := items[len(items)-1]
			if len(synth) != 1 || last.ID != synthTurnPrefix+before[0].ID || results != 0 {
				t.Fatalf("want one process_ended turn end, last, for the message:\n%s", describeItems(items))
			}
			if tu := last.Turn; !tu.Interrupted || tu.TurnCostUSD != nil || tu.CostUSD != 0 || tu.DurationMS < 0 ||
				time.Duration(tu.DurationMS)*time.Millisecond > time.Since(before[0].CreatedAt)+time.Second {
				t.Errorf("turn end %+v", tu)
			}
			if tt.errText != "" {
				if prev := items[len(items)-2]; prev.Kind != KindError || !strings.HasPrefix(prev.Text, tt.errText) {
					t.Errorf("want %q before the turn end:\n%s", tt.errText, describeItems(items))
				}
			}
		})
	}
}

// TestRestartClosesTheLostTurn: a daemon that died with a thread busy left its row live
// and its turn open (nothing ran closeOpenTurn). The next daemon closes it at startup,
// timed to the last thing the run recorded; a log loaded later (a thread stopped before
// turn ends were closed) is closed on its first read. Logs without an open turn are
// left alone.
func TestRestartClosesTheLostTurn(t *testing.T) {
	t0 := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	user := Item{ID: "u1", Ordinal: 1, Kind: KindUserMessage, Text: "go", CreatedAt: t0, UpdatedAt: t0}
	tool := Item{ID: "toolu_1", Ordinal: 2, Kind: KindToolCall, CreatedAt: t0.Add(time.Second), UpdatedAt: t0.Add(4 * time.Second),
		Tool: &ToolCall{ToolUseID: "toolu_1", Name: "Bash", Status: ToolRunning}}
	ended := Item{ID: "turn-r", Ordinal: 3, Kind: KindTurnEnd, CreatedAt: t0.Add(5 * time.Second), UpdatedAt: t0.Add(5 * time.Second),
		Turn: &TurnEnd{Subtype: "success"}}
	fork := Item{ID: "note-fork-p", Ordinal: 3, Kind: KindNote, Text: "Forked from p", CreatedAt: t0.Add(5 * time.Second), UpdatedAt: t0.Add(5 * time.Second)}
	tests := []struct {
		name string
		// live: the row says the process was running (the daemon died); else it was
		// stopped by a daemon that did not close turns.
		live  bool
		items []Item
		// want is the duration of the daemon's turn end; -1 for none.
		want time.Duration
	}{
		{"busy when the daemon died", true, []Item{user, tool}, 4 * time.Second},
		{"stopped mid-turn before the fix", false, []Item{user, tool}, 4 * time.Second},
		{"the turn had ended", true, []Item{user, tool, ended}, -1},
		{"a fork's copied history", true, []Item{user, tool, fork}, -1},
		{"no items", true, nil, -1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, s := idleSetup.start(t)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := e.m.Shutdown(ctx); err != nil {
				t.Fatal(err)
			}
			// What the dead daemon left behind.
			rows, err := loadThreads(ctx, e.m.opts.DB)
			if err != nil || len(rows) != 1 {
				t.Fatalf("load = %v, %v", rows, err)
			}
			row := rows[0]
			if tt.live {
				row.State, row.Status, row.StatusReason = StateConnected, StatusBusy, "working"
			}
			if err := saveThread(ctx, e.m.opts.DB, row); err != nil {
				t.Fatal(err)
			}
			if err := saveItems(ctx, e.m.opts.DB, s.ID, tt.items); err != nil {
				t.Fatal(err)
			}
			e.open()
			if tt.live {
				got, _ := e.m.Get(e.ctx(), s.ID)
				if got.Status != StatusError || got.StatusReason != ReasonInterrupted {
					t.Errorf("status after the restart %v %q", got.Status, got.StatusReason)
				}
			}
			// A lost run is closed at startup, before anyone reads the items.
			stored, err := loadItems(ctx, e.m.opts.DB, s.ID)
			if err != nil {
				t.Fatal(err)
			}
			if !tt.live {
				stored = e.items(s.ID).Items // the first read closes it
				if db, _ := loadItems(ctx, e.m.opts.DB, s.ID); len(db) != len(stored) {
					t.Errorf("read %d items, the database holds %d", len(stored), len(db))
				}
			}
			if tt.want < 0 {
				if len(stored) != len(tt.items) {
					t.Errorf("want the items as they were:\n%s", describeItems(stored))
				}
				return
			}
			if len(stored) != len(tt.items)+1 {
				t.Fatalf("want one more item:\n%s", describeItems(stored))
			}
			last := stored[len(stored)-1]
			if last.ID != synthTurnPrefix+user.ID || !isSynthTurn(last.Turn) || !last.Turn.Interrupted ||
				time.Duration(last.Turn.DurationMS)*time.Millisecond != tt.want {
				t.Errorf("turn end %+v %+v; want %v", last, last.Turn, tt.want)
			}
			if tc := stored[1].Tool; tc == nil || tc.Status != ToolError {
				t.Errorf("running tool call left open: %+v", stored[1])
			}
			// The live snapshot agrees with the database.
			if snap := e.items(s.ID).Items; len(snap) != len(stored) || snap[len(snap)-1].ID != last.ID {
				t.Errorf("snapshot:\n%s", describeItems(snap))
			}
		})
	}
}
