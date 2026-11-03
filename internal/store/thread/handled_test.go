package thread

import (
	"os"
	"slices"
	"strings"
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

// A message sent while the thread starts waits for the handshake behind the first
// prompt. Its item is queued until it goes out, and goes out queued (Claude works on the
// first prompt), so the first prompt's turn end does not count it handled: a forward's
// wake on it does not fire then (the capture has no turn for it, so it never is).
func TestHandledThroughHeldWhileStarting(t *testing.T) {
	gate := initGate(t)
	e := newFixtureEnvAt(t, fixturePath("write-allow"), []string{"CF_FAKE_CLAUDE_INIT_GATE=" + gate.path})
	t.Cleanup(gate.open) // before the env's shutdown (cleanups run last first)
	s := e.create(CreateOptions{PermissionMode: PermissionSupervised, InitialPrompt: "write"})
	held, err := e.m.Send(e.ctx(), s.ID, Message{Text: "forwarded task"})
	if err != nil {
		t.Fatal(err)
	}
	if got := e.snapshot(s.ID); got.State != StateStarting || !held.Queued {
		t.Fatalf("state %v, held item %+v: want starting, queued", got.State, held)
	}
	gate.open()
	e.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })
	parent := e.stopped("parent")
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: s.ID, AfterOrdinal: held.Ordinal, Note: "forwarded"}); err != nil {
		t.Fatal(err)
	}
	e.waitItems(s.ID, "the held message still queued once sent", func(items []Item) bool {
		return slices.ContainsFunc(items, func(x Item) bool { return x.ID == held.ID && x.Queued })
	})
	p := e.items(s.ID).Pending
	if _, err := e.m.Respond(e.ctx(), s.ID, p[0].RequestID, Decision{Allow: true}); err != nil {
		t.Fatal(err)
	}
	first := e.items(s.ID).Items[0]
	got := e.waitFor(s.ID, "the first prompt's turn handled", func(s Thread) bool { return s.HandledThrough >= first.Ordinal && s.StatusReason == "finished" })
	if got.HandledThrough >= held.Ordinal {
		t.Errorf("handled through %d after the first prompt's turn, past the held message (%d)", got.HandledThrough, held.Ordinal)
	}
	time.Sleep(100 * time.Millisecond) // a wake would be queued within the commit
	if w := wakes(e.items(parent.ID).Items); len(w) != 0 {
		t.Errorf("woken by the first prompt's turn: %+v", w)
	}
}

// A message sent during a busy restart is held for the new process; the interrupted
// turn's end does not count it, the new process's turn that reads it does, and only
// then does a forward's wake on it fire.
func TestHandledThroughHeldByRestart(t *testing.T) {
	re := newFixtureEnv(t, "interrupt-pending")
	parent := re.stopped("parent")
	s := re.create(CreateOptions{PermissionMode: PermissionSupervised, InitialPrompt: "write"})
	re.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })
	cid := argOf(re.argvOf(), "--session-id")
	re.writeTranscript(cid, userLine("write"))
	if _, restarted, err := re.m.Restart(re.ctx(), s.ID); err != nil || !restarted {
		t.Fatalf("restart: %v %v", restarted, err)
	}
	re.waitSent("interrupt", func(m map[string]any) bool {
		r, _ := m["request"].(map[string]any)
		return r["subtype"] == "interrupt"
	})
	if _, err := re.m.Send(re.ctx(), s.ID, Message{Text: "forwarded task"}); err != nil {
		t.Fatalf("send during the restart: %v", err)
	}
	items := re.waitItems(s.ID, "the held message written", func(items []Item) bool {
		return slices.ContainsFunc(items, func(x Item) bool { return x.Kind == KindUserMessage && x.Text == "forwarded task" })
	})
	held := items[slices.IndexFunc(items, func(x Item) bool { return x.Kind == KindUserMessage && x.Text == "forwarded task" })]
	// The new process replays the capture's turn for it, which stops at a permission
	// prompt: the turn that reads it has not ended.
	got := re.waitFor(s.ID, "the new turn's permission", func(s Thread) bool {
		return s.State == StateConnected && strings.HasPrefix(s.StatusReason, "permission:")
	})
	if got.HandledThrough >= held.Ordinal {
		t.Fatalf("handled through %d before the turn reading the held message (%d) ended", got.HandledThrough, held.Ordinal)
	}
	if _, err := re.m.Subscribe(re.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: s.ID, AfterOrdinal: held.Ordinal, Note: "forwarded"}); err != nil {
		t.Fatal(err)
	}
	if w := wakes(re.items(parent.ID).Items); len(w) != 0 {
		t.Fatalf("woken before the turn ended: %+v", w)
	}
	var p []PendingRequest
	re.waitItems(s.ID, "the new request", func([]Item) bool { p = re.items(s.ID).Pending; return len(p) > 0 })
	if _, err := re.m.Respond(re.ctx(), s.ID, p[0].RequestID, Decision{Allow: true}); err != nil {
		t.Fatal(err)
	}
	re.waitFor(s.ID, "the turn that read it handled", func(s Thread) bool { return s.HandledThrough >= held.Ordinal })
	re.waitItems(parent.ID, "one wake", func(items []Item) bool { return len(wakes(items)) == 1 })
}
