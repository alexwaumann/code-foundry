package thread

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// The thread lifecycle (lifecycle.go, docs/notes/thread-lifecycle.md): a message starts a
// stopped thread, an idle one stops at its cache expiry.

// userItems are the thread's user messages' texts, in order.
func userItems(items []Item) []string {
	var out []string
	for _, it := range items {
		if it.Kind == KindUserMessage {
			out = append(out, it.Text)
		}
	}
	return out
}

func kindCount(items []Item, k ItemKind) int {
	n := 0
	for _, it := range items {
		if it.Kind == k {
			n++
		}
	}
	return n
}

// spawnCount is how many fake claude processes have started.
func (e *env) spawnCount() int {
	e.t.Helper()
	des, err := os.ReadDir(e.spawns)
	if err != nil {
		e.t.Fatal(err)
	}
	n := 0
	for _, d := range des {
		if strings.HasSuffix(d.Name(), ".json") {
			n++
		}
	}
	return n
}

// sentUser is the user line the daemon wrote with text, decoded.
func (e *env) sentUser(text string) map[string]any {
	e.t.Helper()
	return e.waitSent("the message "+text, func(m map[string]any) bool { return userTextOf(m) == text })
}

func stopped(s Thread) bool { return s.State == StateDisconnected }

// A message to a stopped thread: its item is there when Send returns, before Claude is
// up; claude resumes the conversation with it as the first prompt (one delivery, under
// the item's id); the thread is unarchived.
func TestSendStartsStoppedThread(t *testing.T) {
	e := newEnv(t)
	s := e.create(CreateOptions{InitialPrompt: "first"})
	e.waitItems(s.ID, "the first turn", turnCount(1))
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
	e.resumable(s.ID)
	if _, err := e.m.Archive(e.ctx(), s.ID, true); err != nil {
		t.Fatal(err)
	}
	before := len(e.items(s.ID).Items)

	it, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again", ComposerText: "again!"})
	if err != nil {
		t.Fatal(err)
	}
	if it.Kind != KindUserMessage || it.Text != "again" || it.ComposerText != "again!" || it.Ordinal != int64(before+1) {
		t.Errorf("returned item %+v (had %d items)", it, before)
	}
	if got, ok := e.m.Snapshot().Thread(s.ID); !ok || got.State == StateDisconnected || !got.ArchivedAt.IsZero() {
		t.Errorf("right after the send %+v", got)
	}

	// (The fake replays the capture's ids, so the resumed turn's items replace the
	// first turn's rather than adding new ones.)
	e.waitDeliveries("again", func(f, r int) bool { return r == 1 })
	e.waitFor(s.ID, "the resumed turn over", func(s Thread) bool { return s.State == StateConnected && turnOver(s) })
	items := e.items(s.ID).Items
	if got := userItems(items); !slices.Equal(got, []string{"first", "again"}) {
		t.Errorf("user items %q\n%s", got, describeItems(items))
	}
	argv := e.argvOf()
	if argOf(argv, "--resume") != cid {
		t.Errorf("argv %q, want --resume %s", argv, cid)
	}
	if fresh, resumed := e.waitDeliveries("again", func(f, r int) bool { return r == 1 }); fresh != 0 || resumed != 1 {
		t.Errorf("deliveries fresh %d resumed %d", fresh, resumed)
	}
	if m := e.sentUser("again"); m["uuid"] != it.ID {
		t.Errorf("delivered under %v, item %s", m["uuid"], it.ID)
	}
	got := e.waitFor(s.ID, "connected", func(s Thread) bool { return s.State == StateConnected })
	if got.LastError != "" || got.DisconnectReason != "" {
		t.Errorf("after the start %+v", got)
	}
	if n := kindCount(items, KindNote); n != 0 {
		t.Errorf("a resumed conversation got %d notes", n)
	}
}

// A stopped thread whose transcript is gone starts a new conversation, and the
// timeline says Claude does not remember (a note before the message).
func TestSendStartsNewConversationWhenTranscriptGone(t *testing.T) {
	e := newEnv(t)
	s := e.create(CreateOptions{InitialPrompt: "first"})
	e.waitItems(s.ID, "the first turn", turnCount(1))
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
	e.resumable(s.ID)
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(e.paths.projectDir(e.wt), cid+".jsonl")); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); err != nil {
		t.Fatal(err)
	}
	e.waitDeliveries("again", func(f, r int) bool { return f == 1 })
	items := e.items(s.ID).Items
	argv := e.argvOf()
	if argOf(argv, "--resume") != "" || argOf(argv, "--session-id") == "" || argOf(argv, "--session-id") == cid {
		t.Errorf("argv %q", argv)
	}
	n := slices.IndexFunc(items, func(it Item) bool { return it.Kind == KindNote })
	u := slices.IndexFunc(items, func(it Item) bool { return it.Kind == KindUserMessage && it.Text == "again" })
	if n < 0 || u != n+1 || !strings.Contains(items[n].Text, "does not remember") {
		t.Errorf("note %d, message %d\n%s", n, u, describeItems(items))
	}
	if got := e.snapshot(s.ID); !strings.Contains(got.LastError, "not found") {
		t.Errorf("LastError %q", got.LastError)
	}
}

// Messages that come while a thread starts wait for the handshake: Send returns their
// items at once, in order after the first prompt's, and Claude gets them in that order.
// Two messages racing to start a stopped thread start one process.
func TestSendWhileStartingQueues(t *testing.T) {
	gate := initGate(t)
	e := newFixtureEnvAt(t, fixturePath("text-table"), []string{"CF_FAKE_CLAUDE_INIT_GATE=" + gate.path})
	t.Cleanup(gate.open) // before the env's shutdown (cleanups run last first)
	s := e.create(CreateOptions{InitialPrompt: "first"})
	// The handshake is held: Send returns without waiting for it.
	it, err := e.m.Send(e.ctx(), s.ID, Message{Text: "second"})
	if err != nil {
		t.Fatal(err)
	}
	if got := e.snapshot(s.ID); got.State != StateStarting {
		t.Fatalf("the thread was not starting: %+v", got)
	}
	if got := userItems(e.items(s.ID).Items); !slices.Equal(got, []string{"first", "second"}) || it.Text != "second" {
		t.Errorf("user items %q, returned %+v", got, it)
	}
	gate.open()
	e.sentUser("second")
	var order []string
	for _, m := range e.sent() {
		if txt := userTextOf(m); txt != "" {
			order = append(order, txt)
		}
	}
	if !slices.Equal(order, []string{"first", "second"}) {
		t.Errorf("delivered %q", order)
	}
	e.waitItems(s.ID, "a turn", turnCount(1))

	// Stopped; two messages at once start one process.
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	spawns := e.spawnCount()
	a, b := e.sendAsync(e.ctx(), s.ID, "a"), e.sendAsync(e.ctx(), s.ID, "b")
	if err := waitErr(t, "send a", a); err != nil {
		t.Fatal(err)
	}
	if err := waitErr(t, "send b", b); err != nil {
		t.Fatal(err)
	}
	e.sentUser("a")
	e.sentUser("b")
	if n := e.spawnCount() - spawns; n != 1 {
		t.Errorf("%d processes started for two messages", n)
	}
	if got := userItems(e.items(s.ID).Items); len(got) != 4 {
		t.Errorf("user items %q", got)
	}
}

// A message to a stopped thread starts a turn at once: the status it saved (an unseen
// finished turn here) becomes busy "working" before Claude answers its handshake, as a
// send to a live thread does; an MCP start (no message) keeps it.
func TestSendToStoppedThreadIsBusyAtOnce(t *testing.T) {
	gate := initGate(t)
	e := newFixtureEnvAt(t, fixturePath("text-table"), []string{"CF_FAKE_CLAUDE_INIT_GATE=" + gate.path})
	t.Cleanup(gate.open) // before the env's shutdown (cleanups run last first)
	gate.open()
	s := e.create(CreateOptions{InitialPrompt: "first"})
	e.waitFor(s.ID, "a finished turn", func(s Thread) bool { return s.Status == StatusNeedsAttention })
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "stopped, still finished", func(s Thread) bool { return stopped(s) && s.Status == StatusNeedsAttention })

	// The next start's handshake is held.
	if err := os.Remove(gate.path); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "second"}); err != nil {
		t.Fatal(err)
	}
	if got := e.snapshot(s.ID); got.State != StateStarting || got.Status != StatusBusy || got.StatusReason != "working" {
		t.Fatalf("after a send to a stopped thread: state %v status %v %q", got.State, got.Status, got.StatusReason)
	}
	gate.open()
	e.sentUser("second")
}

// initGate holds a fake claude's initialize answer until open (CF_FAKE_CLAUDE_INIT_GATE).
type gateFile struct {
	t    *testing.T
	path string
}

func initGate(t *testing.T) gateFile {
	return gateFile{t: t, path: filepath.Join(t.TempDir(), "init-gate")}
}

func (g gateFile) open() {
	if err := os.WriteFile(g.path, nil, 0o600); err != nil {
		g.t.Error(err)
	}
}

// A message to a closing thread waits for the exit, then starts a new process.
func TestSendWhileClosingWaits(t *testing.T) {
	e := newFixtureEnvAt(t, fixturePath("text-table"), []string{"CF_FAKE_CLAUDE_EXIT_DELAY=400ms"})
	s := e.connected(CreateOptions{})
	old := e.pid(s.ID)
	closed := make(chan error, 1)
	go func() { closed <- e.m.Close(e.ctx(), s.ID) }()
	e.waitFor(s.ID, "closing", func(s Thread) bool { return s.State == StateClosing })
	it, err := e.m.Send(e.ctx(), s.ID, Message{Text: "after"})
	if err != nil || it.Text != "after" {
		t.Fatalf("send while closing: %+v, %v", it, err)
	}
	if err := waitErr(t, "the close", closed); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "started again", func(s Thread) bool { return s.State == StateConnected })
	if e.pid(s.ID) == old {
		t.Error("the message went to the closing process")
	}
	e.waitItems(s.ID, "its turn", turnCount(1))
	if fresh, resumed := e.deliveries("after"); fresh+resumed != 1 {
		t.Errorf("delivered %d times", fresh+resumed)
	}
}

// A start that fails: Send still returns the accepted item; an error item follows;
// the status is error "did not start" and the thread stays stopped. The next message
// tries again.
func TestSendSpawnFailure(t *testing.T) {
	tests := []struct {
		name string
		// breakIt makes the next start fail; fixIt undoes it.
		breakIt, fixIt func(e *env, s Thread)
		wantText       string
	}{
		{
			name:     "worktree gone",
			breakIt:  func(e *env, _ Thread) { mustRename(e.t, e.home, e.home+".gone") },
			fixIt:    func(e *env, _ Thread) { mustRename(e.t, e.home+".gone", e.home) },
			wantText: "Claude did not start: failed precondition: worktree ",
		},
		{
			name:     "claude missing",
			breakIt:  func(e *env, _ Thread) { e.restart(func(o *Options) { o.Claude = "/nonexistent/claude" }) },
			fixIt:    func(e *env, _ Thread) { e.restart() },
			wantText: "Claude did not start: spawn claude: ",
		},
		{
			name: "claude exits before its handshake",
			breakIt: func(e *env, _ Thread) {
				e.restart(func(o *Options) { o.Env[0] = fakeClaudeEnv + "=" + fixturePath("no-such-fixture") })
			},
			fixIt:    func(e *env, _ Thread) { e.restart() },
			wantText: "Claude did not start: exit code 2: fake claude",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			s := e.create(CreateOptions{NoProject: true, InitialPrompt: "first"})
			e.waitItems(s.ID, "the first turn", turnCount(1))
			if err := e.m.Close(e.ctx(), s.ID); err != nil {
				t.Fatal(err)
			}
			tt.breakIt(e, s)
			it, err := e.m.Send(e.ctx(), s.ID, Message{Text: "lost"})
			if err != nil || it.Text != "lost" {
				t.Fatalf("send: %+v, %v", it, err)
			}
			got := e.waitFor(s.ID, "stopped with an error", func(s Thread) bool {
				return stopped(s) && s.Status == StatusError
			})
			if got.StatusReason != ReasonStartFailed || got.LastError == "" {
				t.Errorf("after the failed start %+v", got)
			}
			items := e.items(s.ID).Items
			last := items[len(items)-1]
			if last.Kind != KindError || !strings.HasPrefix(last.Text, tt.wantText) || items[len(items)-2].ID != it.ID {
				t.Errorf("want the message then %q:\n%s", tt.wantText, describeItems(items))
			}
			if n := kindCount(items, KindError); n != 1 {
				t.Errorf("%d error items", n)
			}

			tt.fixIt(e, s)
			if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "retry"}); err != nil {
				t.Fatal(err)
			}
			e.waitFor(s.ID, "started", func(s Thread) bool { return s.State == StateConnected && s.Status != StatusError })
		})
	}
}

func mustRename(t *testing.T, from, to string) {
	t.Helper()
	if err := os.Rename(from, to); err != nil {
		t.Fatal(err)
	}
}

// Respond and Interrupt on a stopped thread: no pending request there; nothing to stop.
func TestRespondInterruptStopped(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{})
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Respond(e.ctx(), s.ID, "r1", Decision{Allow: true}); !errors.Is(err, ErrFailedPrecondition) ||
		strings.Contains(err.Error(), "reconnect") {
		t.Errorf("respond: %v", err)
	}
	if err := e.m.Interrupt(e.ctx(), s.ID); err != nil {
		t.Errorf("interrupt: %v", err)
	}
	if got := e.snapshot(s.ID); !stopped(got) {
		t.Errorf("started by respond or interrupt: %+v", got)
	}
}

// Model, effort and permission mode changed while a thread is stopped go to its row
// (persisted) without starting Claude; the next start passes them.
func TestSettingsOnStoppedThread(t *testing.T) {
	e := newEnv(t)
	s := e.create(CreateOptions{Model: "opus", Effort: "low", PermissionMode: PermissionSupervised, InitialPrompt: "first"})
	e.waitItems(s.ID, "the first turn", turnCount(1))
	e.resumable(s.ID)
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	spawns := e.spawnCount()
	if _, err := e.m.SetModel(e.ctx(), s.ID, "haiku"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.SetEffort(e.ctx(), s.ID, "high"); err != nil {
		t.Fatal(err)
	}
	got, err := e.m.SetPermissionMode(e.ctx(), s.ID, PermissionAcceptEdits)
	if err != nil {
		t.Fatal(err)
	}
	if got.Model != "haiku" || got.Effort != "high" || got.PermissionMode != PermissionAcceptEdits || got.EffortPending || !stopped(got) {
		t.Errorf("row %+v", got)
	}
	if n := e.spawnCount() - spawns; n != 0 {
		t.Errorf("%d processes started for settings", n)
	}
	e.restart()
	if got := e.snapshot(s.ID); got.Model != "haiku" || got.Effort != "high" || got.PermissionMode != PermissionAcceptEdits {
		t.Errorf("after a daemon restart %+v", got)
	}
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); err != nil {
		t.Fatal(err)
	}
	argv := e.waitArgv("the start", func(a []string) bool { return argOf(a, "--resume") != "" })
	if argOf(argv, "--model") != "haiku" || argOf(argv, "--effort") != "high" || argOf(argv, "--permission-mode") != "acceptEdits" {
		t.Errorf("argv %q", argv)
	}
}

// The slash commands and the MCP status Claude last reported outlive its process and a
// daemon restart; a cached MCP read does not start Claude.
func TestThreadCacheSurvivesRestart(t *testing.T) {
	e := newFixtureEnvAt(t, writeCommandsTurn(t), []string{"CF_FAKE_CLAUDE_COMMANDS=" + fixturePath("commands"),
		"CF_FAKE_CLAUDE_MCP=" + mcpFixture()})
	s := e.connected(CreateOptions{})
	cmds := e.waitCommands(s.ID, "after the handshake", func(cs []SlashCommand) bool { return len(cs) > 0 })
	mcp, err := e.m.McpStatus(e.ctx(), s.ID, false)
	if err != nil || mcp == nil || len(mcp.Servers) != 5 {
		t.Fatalf("mcp %+v, %v", mcp, err)
	}
	e.restart()
	snap := e.items(s.ID)
	if !slices.Equal(names(snap.Commands), names(cmds)) {
		t.Errorf("commands after a restart %q", names(snap.Commands))
	}
	if snap.Mcp == nil || len(snap.Mcp.Servers) != 5 || !snap.Mcp.CheckedAt.Equal(mcp.CheckedAt) ||
		serverOf(t, snap.Mcp, "claude.ai Claude Docs").Status != McpConnected {
		t.Errorf("mcp after a restart %+v", snap.Mcp)
	}
	if cs, err := e.m.SlashCommands(e.ctx(), s.ID); err != nil || len(cs) != len(cmds) {
		t.Errorf("SlashCommands %q, %v", names(cs), err)
	}
	if got, err := e.m.McpStatus(e.ctx(), s.ID, false); err != nil || got == nil || len(got.Servers) != 5 {
		t.Errorf("McpStatus %+v, %v", got, err)
	}
	if got := e.snapshot(s.ID); !stopped(got) {
		t.Errorf("a cached read started it: %+v", got)
	}
	// A command the app replaces is refused from the saved list, before any start.
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "/clear"}); err == nil {
		t.Error("/clear was sent")
	}
}

// A process that ends mid-turn adds one error item; one that ends idle adds none.
func TestProcessDeathItems(t *testing.T) {
	t.Run("mid-turn", func(t *testing.T) {
		e := newFixtureEnv(t, "write-allow")
		s := e.create(CreateOptions{InitialPrompt: "write it"})
		e.waitFor(s.ID, "asking", func(s Thread) bool { return s.Status == StatusNeedsAttention })
		e.exit(s.ID, 1)
		got := e.waitFor(s.ID, "stopped", stopped)
		items := e.items(s.ID).Items
		if n := kindCount(items, KindError); n != 1 {
			t.Fatalf("%d error items:\n%s", n, describeItems(items))
		}
		errItem, _ := lastKind(items, KindError)
		if errItem.Text != "Claude stopped unexpectedly (exit code 1: fake claude: exit 1)" {
			t.Errorf("error item %q", errItem.Text)
		}
		if strings.Contains(strings.ToLower(errItem.Text), "connect") || got.DisconnectReason != ReasonCrashed {
			t.Errorf("after the crash %+v", got)
		}
	})
	for _, code := range []int{0, 1} {
		t.Run("idle exit "+map[int]string{0: "0", 1: "1"}[code], func(t *testing.T) {
			e := newEnv(t)
			s := e.create(CreateOptions{InitialPrompt: "hi"})
			e.waitItems(s.ID, "the turn", turnCount(1))
			e.waitFor(s.ID, "idle", turnOver)
			e.exit(s.ID, code)
			got := e.waitFor(s.ID, "stopped", stopped)
			if n := kindCount(e.items(s.ID).Items, KindError); n != 0 {
				t.Errorf("%d error items for an idle exit", n)
			}
			if got.Status == StatusError {
				t.Errorf("status after an idle exit %+v", got)
			}
		})
	}
}

// idleEnv is an env on a test clock whose idle loop never ticks on its own (tests call
// idleHold), with a 10 minute cache and a 1 minute grace.
func idleEnv(t *testing.T, fixture string, vars []string, mutate ...func(*Options)) (*env, *testClock) {
	t.Helper()
	clock := newTestClock()
	all := append([]func(*Options){clock.opts(), func(o *Options) {
		o.IdleCheckInterval, o.IdleGrace, o.CacheTTL = time.Hour, time.Minute, 10*time.Minute
	}}, mutate...)
	return newFixtureEnvAt(t, fixturePath(fixture), vars, all...), clock
}

// idleHold runs one idle check of the thread's runner at now and returns what held it
// ("" when it began to stop).
func (e *env) idleHold(id string, now time.Time) string {
	e.t.Helper()
	r := e.runnerOf(id)
	if r == nil {
		e.t.Fatalf("thread %s has no process", id)
	}
	done := make(chan string, 1)
	deadline := time.Now().Add(5 * time.Second)
	for !r.requestIdleCheck(idleCheck{now: now, done: done}) {
		if time.Now().After(deadline) {
			e.t.Fatal("the idle check was never taken")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case h := <-done:
		return h
	case <-time.After(5 * time.Second):
		e.t.Fatal("no answer to the idle check")
		return ""
	}
}

// A thread idle at its prompt stops at its cache expiry, not before; the status it had
// stays ("finished" unseen), the disconnect reason is idle, and nothing is added to the
// timeline. The next message starts it again.
func TestIdleStopAtCacheExpiry(t *testing.T) {
	e, clock := idleEnv(t, "text-table", nil)
	s := e.create(CreateOptions{InitialPrompt: "hi"})
	e.waitItems(s.ID, "the turn", turnCount(1))
	s = e.waitFor(s.ID, "finished", func(s Thread) bool { return s.StatusReason == "finished" && !s.CacheExpiresAt.IsZero() })
	exp := s.CacheExpiresAt
	if want := clock.Now().Add(10 * time.Minute); !exp.Equal(want) {
		t.Fatalf("expiry %s, want %s", exp, want)
	}
	before := len(e.items(s.ID).Items)
	if h := e.idleHold(s.ID, exp.Add(-time.Second)); h != "cache warm" {
		t.Errorf("a second before the expiry: %q", h)
	}
	if h := e.idleHold(s.ID, exp); h != "" {
		t.Fatalf("at the expiry: %q", h)
	}
	got := e.waitFor(s.ID, "stopped", stopped)
	if got.DisconnectReason != ReasonIdle || got.Status != StatusNeedsAttention || got.StatusReason != "finished" {
		t.Errorf("after the idle stop %+v", got)
	}
	if n := len(e.items(s.ID).Items); n != before {
		t.Errorf("the idle stop added %d items", n-before)
	}
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "back"}); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "started", func(s Thread) bool { return s.State == StateConnected })
}

// The loop: on its own tick it stops an expired thread.
func TestIdleStopLoop(t *testing.T) {
	e, clock := idleEnv(t, "text-table", nil, func(o *Options) { o.IdleCheckInterval = 5 * time.Millisecond })
	s := e.create(CreateOptions{InitialPrompt: "hi"})
	e.waitItems(s.ID, "the turn", turnCount(1))
	e.waitFor(s.ID, "a result", func(s Thread) bool { return !s.CacheExpiresAt.IsZero() && turnOver(s) })
	time.Sleep(30 * time.Millisecond)
	if got := e.snapshot(s.ID); stopped(got) {
		t.Fatalf("stopped before its expiry: %+v", got)
	}
	clock.advance(11 * time.Minute)
	if got := e.waitFor(s.ID, "stopped", stopped); got.DisconnectReason != ReasonIdle {
		t.Errorf("after the loop %+v", got)
	}
}

// sessions.cache_ttl_seconds moves the expiry both ways; a thread without a result
// counts from its last activity; the grace holds a young process past an old expiry.
func TestIdleStopExpiryRules(t *testing.T) {
	t.Run("ttl changes", func(t *testing.T) {
		e, clock := idleEnv(t, "text-table", nil)
		s := e.create(CreateOptions{InitialPrompt: "hi"})
		e.waitItems(s.ID, "the turn", turnCount(1))
		s = e.waitFor(s.ID, "a result", func(s Thread) bool { return !s.CacheExpiresAt.IsZero() && turnOver(s) })
		result := s.LastResultAt
		e.m.SetCacheTTL(30 * time.Minute)
		if h := e.idleHold(s.ID, result.Add(11*time.Minute)); h != "cache warm" {
			t.Errorf("longer ttl: %q", h)
		}
		e.m.SetCacheTTL(2 * time.Minute)
		if h := e.idleHold(s.ID, clock.Now().Add(90*time.Second)); h != "grace" && h != "cache warm" {
			t.Errorf("before the shorter expiry: %q", h)
		}
		if h := e.idleHold(s.ID, result.Add(2*time.Minute)); h != "" {
			t.Errorf("shorter ttl: %q", h)
		}
		e.waitFor(s.ID, "stopped", stopped)
	})
	t.Run("no result", func(t *testing.T) {
		e, clock := idleEnv(t, "text-table", nil)
		s := e.connected(CreateOptions{})
		start := clock.Now()
		if h := e.idleHold(s.ID, start.Add(9*time.Minute)); h != "cache warm" {
			t.Errorf("9 min after the start: %q", h)
		}
		if h := e.idleHold(s.ID, start.Add(10*time.Minute)); h != "" {
			t.Errorf("10 min after the start: %q", h)
		}
	})
	t.Run("grace", func(t *testing.T) {
		e, clock := idleEnv(t, "text-table", nil, func(o *Options) { o.IdleGrace = 5 * time.Minute; o.CacheTTL = time.Minute })
		s := e.connected(CreateOptions{})
		if h := e.idleHold(s.ID, clock.Now().Add(2*time.Minute)); h != "grace" {
			t.Errorf("2 min after the start: %q", h)
		}
		if h := e.idleHold(s.ID, clock.Now().Add(5*time.Minute)); h != "" {
			t.Errorf("5 min after the start: %q", h)
		}
	})
}

// What holds a running thread past its expiry, through the runner.
func TestIdleStopHolds(t *testing.T) {
	far := 24 * time.Hour
	tests := []struct {
		name, fixture string
		vars          []string
		gated         bool // the handshake is held until the test ends
		// setup brings the thread to the state to hold in.
		setup func(e *env) Thread
		want  string
	}{
		{name: "a pending permission request", fixture: "write-allow", want: "pending request", setup: func(e *env) Thread {
			s := e.create(CreateOptions{InitialPrompt: "write it"})
			return e.waitFor(s.ID, "asking", func(s Thread) bool { return s.Status == StatusNeedsAttention })
		}},
		{name: "a background shell", fixture: "shells", want: "background work", setup: func(e *env) Thread {
			s := e.create(CreateOptions{InitialPrompt: "launch"})
			e.waitItems(s.ID, "launched", turnCount(1))
			return e.waitFor(s.ID, "a shell", shellsRunning(1))
		}},
		{name: "a background agent", fixture: "agents", want: "background work", setup: func(e *env) Thread {
			s := e.create(CreateOptions{InitialPrompt: "launch"})
			e.waitItems(s.ID, "launched", turnCount(1))
			return e.waitFor(s.ID, "running", func(s Thread) bool { _, bg := s.AgentsRunning(); return bg == 1 })
		}},
		{name: "a message waiting for the handshake", fixture: "text-table", gated: true,
			want: "starting", setup: func(e *env) Thread {
				s := e.create(CreateOptions{InitialPrompt: "first"})
				if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "second"}); err != nil {
					e.t.Fatal(err)
				}
				return s
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vars := tt.vars
			var gate gateFile
			if tt.gated {
				gate = initGate(t)
				vars = append(vars, "CF_FAKE_CLAUDE_INIT_GATE="+gate.path)
			}
			e, clock := idleEnv(t, tt.fixture, vars)
			if tt.gated {
				t.Cleanup(gate.open)
			}
			s := tt.setup(e)
			if h := e.idleHold(s.ID, clock.Now().Add(far)); h != tt.want {
				t.Errorf("hold %q, want %q", h, tt.want)
			}
			if got := e.snapshot(s.ID); stopped(got) {
				t.Errorf("stopped: %+v", got)
			}
		})
	}
}

// A background shell ended at the prompt: Claude is about to start a turn to report it
// (the wake hold, wake.go), so the thread is not idle yet, even with nothing running.
// Once that turn ended it stops.
func TestIdleStopHoldsForTheWake(t *testing.T) {
	gates := t.TempDir()
	release := func(name string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(gates, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	e, clock := idleEnv(t, "shells", []string{"CF_FAKE_CLAUDE_UNPROMPTED=" + gates})
	s := e.create(CreateOptions{InitialPrompt: "launch"})
	e.waitItems(s.ID, "launched", turnCount(1))
	e.waitFor(s.ID, "a shell at the prompt", func(s Thread) bool { return s.BackgroundShellsRunning == 1 && turnOver(s) })
	far := clock.Now().Add(24 * time.Hour)
	if h := e.idleHold(s.ID, far); h != "background work" {
		t.Errorf("with the shell running: %q", h)
	}
	release("turn-2") // the end frames; Claude's own turn is held before its init
	e.waitFor(s.ID, "a wake due", func(s Thread) bool { return s.BackgroundShellsRunning == 0 && s.WakePending })
	if h := e.idleHold(s.ID, far); h != "background work" {
		t.Errorf("with Claude's turn due: %q", h)
	}
	release("turn-2.init")
	e.waitFor(s.ID, "the turn over", func(s Thread) bool { return !s.WakePending && turnOver(s) })
	if h := e.idleHold(s.ID, far); h != "" {
		t.Errorf("after Claude's turn: %q", h)
	}
	if got := e.waitFor(s.ID, "stopped", stopped); got.DisconnectReason != ReasonIdle {
		t.Errorf("after the stop %+v", got)
	}
}

// Archived and snoozed threads are stopped already: the check passes them by.
func TestIdleStopSkipsStopped(t *testing.T) {
	e, clock := idleEnv(t, "text-table", nil)
	a := e.connected(CreateOptions{Name: "archived"})
	z := e.connected(CreateOptions{Name: "snoozed"})
	if _, err := e.m.Archive(e.ctx(), a.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Snooze(e.ctx(), z.ID, clock.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	clock.advance(48 * time.Hour)
	e.m.stopIdle()
	for _, id := range []string{a.ID, z.ID} {
		if got := e.snapshot(id); got.DisconnectReason != ReasonClosed {
			t.Errorf("%s: %+v", id, got)
		}
	}
}

// Every hold, one at a time, against an idle thread past its expiry.
func TestIdleHoldOf(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	base := idleInputs{
		now: now, atPrompt: true, startedAt: now.Add(-time.Hour), cacheExpiresAt: now.Add(-time.Second),
		lastActive: now.Add(-2 * time.Hour), cacheTTL: time.Hour, idleGrace: 5 * time.Minute,
	}
	tests := []struct {
		name string
		mod  func(*idleInputs)
		want string
	}{
		{"expired", func(*idleInputs) {}, ""},
		{"expires now", func(in *idleInputs) { in.cacheExpiresAt = now }, ""},
		{"closing", func(in *idleInputs) { in.closing = true }, "closing"},
		{"starting or restarting", func(in *idleInputs) { in.starting = true }, "starting"},
		{"send in flight", func(in *idleInputs) { in.messageOnItsWay = true }, "message on its way"},
		{"effort restart", func(in *idleInputs) { in.effortChange = true }, "effort change"},
		{"pending request", func(in *idleInputs) { in.pendingRequest = true }, "pending request"},
		{"busy", func(in *idleInputs) { in.atPrompt = false }, "busy"},
		{"unfinished item", func(in *idleInputs) { in.unfinishedItem = true }, "unfinished item"},
		{"background agent or shell", func(in *idleInputs) { in.backgroundWork = true }, "background work"},
		{"grace", func(in *idleInputs) { in.startedAt = now.Add(-4 * time.Minute) }, "grace"},
		{"grace over", func(in *idleInputs) { in.startedAt = now.Add(-5 * time.Minute) }, ""},
		{"cache warm", func(in *idleInputs) { in.cacheExpiresAt = now.Add(time.Second) }, "cache warm"},
		{"no result: from the last activity", func(in *idleInputs) { in.cacheExpiresAt = time.Time{} }, ""},
		{"no result, active lately", func(in *idleInputs) {
			in.cacheExpiresAt, in.lastActive = time.Time{}, now.Add(-59*time.Minute)
		}, "cache warm"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in := base
			tt.mod(&in)
			if got := idleHoldOf(in); got != tt.want {
				t.Errorf("idleHoldOf = %q, want %q", got, tt.want)
			}
		})
	}
}

// Shutdown began while claude started: spawn's commit does not attach the runner (no
// m.wg.Add racing Shutdown's Wait); the process goes and the start fails.
func TestSpawnAfterShutdownBegan(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{})
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	e.m.mu.Lock()
	e.m.closed = true
	e.m.mu.Unlock()
	cid, err := newUUID()
	if err != nil {
		t.Fatal(err)
	}
	if err := e.m.spawn(e.ctx(), s.ID, launch{newID: cid}); !errors.Is(err, ErrClosed) {
		t.Fatalf("spawn: %v", err)
	}
	e.m.mu.Lock()
	run := e.m.recs[s.ID].run
	e.m.mu.Unlock()
	if run != nil {
		t.Error("a runner was attached after Shutdown began")
	}
}

// The MCP saves follow the checks' tickets: a save that comes after a later check's is
// dropped (setMcp saves outside its lock).
func TestThreadLogMcpSavesInOrder(t *testing.T) {
	log := newThreadLog("s1", bus.New(), time.Now, nil)
	var saved []McpTrigger
	log.saveMcp = func(s *McpStatus) { saved = append(saved, s.Trigger) }
	log.persistMcp(2, &McpStatus{Trigger: McpTriggerRefresh})
	log.persistMcp(1, &McpStatus{Trigger: McpTriggerTurn})
	log.persistMcp(3, &McpStatus{Trigger: McpTriggerReconnect})
	if want := []McpTrigger{McpTriggerRefresh, McpTriggerReconnect}; !slices.Equal(saved, want) {
		t.Errorf("saved %v, want %v", saved, want)
	}
}
