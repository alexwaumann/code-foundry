package thread

import (
	"os"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// The log's handled ordinal: a message counts once a turn that took it in ended; one
// queued while a turn ran counts only at the turn end after Claude read it, or after the
// process left it unread; subagents' items do not count.
func TestHandledThrough(t *testing.T) {
	user := func(id string) Item { return Item{ID: id, Kind: KindUserMessage} }
	queued := func(id string) Item { return Item{ID: id, Kind: KindUserMessage, Queued: true} }
	end := func(id string) Item { return Item{ID: id, Kind: KindTurnEnd, Turn: &TurnEnd{Subtype: "success"}} }
	log := newThreadLog("th", bus.New(), time.Now, nil)
	w := itemWriter{log: log, save: func(Item) {}}
	check := func(what string, want int64) {
		t.Helper()
		if got := log.handledThrough(); got != want {
			t.Errorf("%s: handled = %d, want %d", what, got, want)
		}
	}
	check("empty", 0)
	w.add(user("u1")) // 1
	check("a turn running", 0)
	w.add(Item{ID: "t", Kind: KindToolCall}) // 2
	w.add(queued("q1"))                      // 3: sent while it works
	w.add(Item{ID: "sub", Kind: KindTurnEnd, ParentToolUseID: "agent", Turn: &TurnEnd{}})
	check("a subagent's turn end", 0)
	w.add(end("e1")) // 5
	check("the turn ended without reading the queued message", 1)
	w.consume("q1", true)
	w.add(end("e2"))
	check("the next turn read it", 3)
	w.add(queued("q2"))                                // 7
	w.change("q2", func(x *Item) { x.Queued = false }) // the process ended (closeUnfinished)
	closeOpenTurn(w, log.now())
	check("left unread by a process that ended", 7)

	// Loaded from the database: the same reading.
	again := newThreadLog("th", bus.New(), time.Now, log.snapshot().Items)
	if got := again.handledThrough(); got != 7 {
		t.Errorf("loaded: handled = %d, want 7", got)
	}
}

// A running thread publishes its handled ordinal with the status: after its first turn
// the prompt's, after a second turn ending with the same status ("finished" again) the
// second message's.
func TestHandledThroughPublished(t *testing.T) {
	const result = `{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"num_turns":1,"result":"ok","session_id":"x","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}`
	path := t.TempDir() + "/two-turns.jsonl"
	if err := os.WriteFile(path, []byte(result+"\n"+result+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	e := newFixtureEnvAt(t, path, nil)
	s := e.create(CreateOptions{InitialPrompt: "go"})
	first := e.waitItems(s.ID, "the first turn", func(items []Item) bool { return len(items) >= 2 })[0]
	e.waitFor(s.ID, "the first turn handled", func(s Thread) bool { return s.HandledThrough == first.Ordinal && s.StatusReason == "finished" })
	it, err := e.m.Send(e.ctx(), s.ID, Message{Text: "more"})
	if err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "the second turn handled", func(s Thread) bool {
		return s.HandledThrough == it.Ordinal && s.Status == StatusNeedsAttention && s.StatusReason == "finished"
	})
}
