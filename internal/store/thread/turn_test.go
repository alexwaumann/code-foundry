package thread

import (
	"os"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// The log's turn start follows lastTurn (the wake's rule) through every way its items
// change: a follow-up starts a turn, a message read mid-turn or still queued does not,
// one placed after the turn end does, subagents' items do not count, a dropped message
// takes its start with it, and a log loaded from the database reads the same.
func TestTurnStarted(t *testing.T) {
	t0 := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	now := t0
	clock := func() time.Time { return now }
	at := func(min int) { now = t0.Add(time.Duration(min) * time.Minute) }
	log := newThreadLog("th", bus.New(), clock, nil)
	w := itemWriter{log: log, save: func(Item) {}}
	check := func(what string, want time.Time) {
		t.Helper()
		if got := log.turnStarted(); !got.Equal(want) {
			t.Errorf("%s: turn started %v, want %v", what, got, want)
		}
		if started, _, _ := lastTurn(log.snapshot().Items); !started.Equal(want) {
			t.Errorf("%s: lastTurn says %v, want %v", what, started, want)
		}
	}
	user := func(id string) Item { return Item{ID: id, Kind: KindUserMessage} }
	end := func(id string) Item { return Item{ID: id, Kind: KindTurnEnd, Turn: &TurnEnd{Subtype: "success"}} }

	check("empty", time.Time{})
	at(1)
	w.add(user("u1"))
	check("the first message", t0.Add(time.Minute))
	at(2)
	w.add(user("steer"))
	check("a message read mid-turn", t0.Add(time.Minute))
	at(3)
	w.add(Item{ID: "a1", Kind: KindAssistantText, Text: "working"})
	w.add(Item{ID: "q1", Kind: KindUserMessage, Queued: true})
	w.add(end("e1"))
	check("a queued message is not read", t0.Add(time.Minute))
	at(4)
	w.add(Item{ID: "a2", Kind: KindAssistantText, Text: "after"})
	w.consume("q1", true)
	check("placed after the turn end: a turn of its own", t0.Add(3*time.Minute))
	w.add(end("e2"))
	at(5)
	w.add(Item{ID: "sub", Kind: KindUserMessage, ParentToolUseID: "agent"})
	check("a subagent's prompt", t0.Add(3*time.Minute))
	w.add(user("u2"))
	check("a follow-up", t0.Add(5*time.Minute))
	again := newThreadLog("th", bus.New(), clock, log.snapshot().Items)
	if got := again.turnStarted(); !got.Equal(t0.Add(5 * time.Minute)) {
		t.Errorf("loaded: turn started %v, want the follow-up's", got)
	}
	log.dropItem("u2")
	check("the follow-up taken back", t0.Add(3*time.Minute))
}

// A report is stale once a turn started after it, compared at millisecond precision (a
// fire's and a persisted time are cut to it); never without a report.
func TestThreadReportStale(t *testing.T) {
	t0 := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	done := func(at time.Time) Report { return Report{Status: ReportDone, Summary: "ok", At: at} }
	tests := []struct {
		name string
		t    Thread
		want bool
	}{
		{"no turn", Thread{Report: done(t0)}, false},
		{"report after the turn started", Thread{Report: done(t0.Add(time.Minute)), TurnStartedAt: t0}, false},
		{"a turn started after the report", Thread{Report: done(t0), TurnStartedAt: t0.Add(time.Minute)}, true},
		{"the same millisecond", Thread{Report: done(t0), TurnStartedAt: t0.Add(500 * time.Microsecond)}, false},
		{"no report", Thread{TurnStartedAt: t0.Add(time.Minute)}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.t.ReportStale(); got != tt.want {
				t.Errorf("ReportStale = %v, want %v", got, tt.want)
			}
		})
	}
}

// A running thread publishes its turn start with the status and saves it: the prompt's
// time after the first turn, the follow-up's after the second; the row has it too.
func TestTurnStartedPublished(t *testing.T) {
	const result = `{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"num_turns":1,"result":"ok","session_id":"x","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}`
	path := t.TempDir() + "/two-turns.jsonl"
	if err := os.WriteFile(path, []byte(result+"\n"+result+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	e := newFixtureEnvAt(t, path, nil)
	s := e.create(CreateOptions{InitialPrompt: "go"})
	first := e.waitItems(s.ID, "the first turn", func(items []Item) bool { return len(items) >= 2 })[0]
	e.waitFor(s.ID, "the first turn's start", func(s Thread) bool {
		return s.TurnStartedAt.Equal(first.CreatedAt) && s.StatusReason == "finished"
	})
	it, err := e.m.Send(e.ctx(), s.ID, Message{Text: "more"})
	if err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "the second turn's start", func(s Thread) bool {
		return s.TurnStartedAt.Equal(it.CreatedAt) && s.Status == StatusNeedsAttention && s.StatusReason == "finished"
	})
	rows, err := loadThreads(e.ctx(), e.m.opts.DB)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if r.ID == s.ID && !r.TurnStartedAt.Equal(it.CreatedAt.Truncate(time.Millisecond)) {
			t.Errorf("saved turn start %v, want %v", r.TurnStartedAt, it.CreatedAt)
		}
	}
}
