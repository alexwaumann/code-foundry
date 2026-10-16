package thread

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// argvOf is the fake claude's latest argv (each spawn overwrites it).
func (re *env) argvOf() []string {
	var argv []string
	if b, err := os.ReadFile(re.argv); err == nil {
		_ = json.Unmarshal(b, &argv)
	}
	return argv
}

// waitArgv waits until the latest spawn's argv satisfies cond.
func (re *env) waitArgv(what string, cond func([]string) bool) []string {
	re.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		argv := re.argvOf()
		if cond(argv) {
			return argv
		}
		if time.Now().After(deadline) {
			re.t.Fatalf("timed out waiting for %s; argv %q", what, argv)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// turnOver reports a thread whose turn has ended: idle when something watched it,
// or "finished" (needs attention) when nothing did. Which one depends on timing.
func turnOver(s Session) bool {
	return s.Status == StatusIdle || s.Status == StatusNeedsAttention && s.StatusReason == "finished"
}

func hasEffortNote(effort string) func([]Item) bool {
	return func(items []Item) bool {
		return slices.ContainsFunc(items, func(it Item) bool { return it.Kind == KindCommandOutput && it.Text == "Set effort to "+effort })
	}
}

// An idle thread restarts at once: the new process resumes the conversation with the
// new effort and keeps the rest of the launch; a send during the restart waits for it.
func TestRenderedSetEffortIdleRestarts(t *testing.T) {
	re := newFixtureEnv(t, "text-table")
	s := re.create(CreateOptions{Model: "haiku", Effort: "low", PermissionMode: PermissionSupervised})
	re.waitFor(s.ID, "idle", func(s Session) bool { return s.Status == StatusIdle })
	first := re.argvOf()
	cid := argOf(first, "--session-id")
	if argOf(first, "--effort") != "low" || cid == "" {
		t.Fatalf("first argv %q", first)
	}
	re.writeTranscript(cid, userLine("earlier"))

	got, err := re.m.SetEffort(re.ctx(), s.ID, "high")
	if err != nil || got.Effort != "high" || !got.EffortPending {
		t.Fatalf("set effort %+v %v", got, err)
	}
	// Sent while the restart runs: held, then sent to the new process.
	it, err := re.m.Send(re.ctx(), s.ID, Message{Text: "hello again"})
	if err != nil || it.Kind != KindUserMessage {
		t.Fatalf("send during the restart: %+v %v", it, err)
	}
	argv := re.waitArgv("the restart", func(a []string) bool { return argOf(a, "--effort") == "high" })
	if argOf(argv, "--resume") != cid || slices.Contains(argv, "--session-id") || argOf(argv, "--model") != "haiku" ||
		argOf(argv, "--permission-mode") != "manual" || !slices.Contains(argv, "--include-partial-messages") {
		t.Errorf("restart argv %q", argv)
	}
	items := re.waitItems(s.ID, "the effort note and the turn", func(items []Item) bool {
		return hasEffortNote("high")(items) && hasTurnEnd(items)
	})
	note := slices.IndexFunc(items, func(it Item) bool { return it.Kind == KindCommandOutput })
	msg := slices.IndexFunc(items, func(it Item) bool { return it.Kind == KindUserMessage })
	if note < 0 || msg < note {
		t.Errorf("the note should come before the held message:\n%s", describeItems(items))
	}
	got = re.waitFor(s.ID, "applied", func(s Session) bool { return !s.EffortPending && turnOver(s) })
	if got.State != StateConnected || got.Effort != "high" {
		t.Errorf("after the restart %+v", got)
	}
	// The row keeps the effort for later spawns.
	if err := re.m.Close(re.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := re.m.Get(re.ctx(), s.ID); got.Effort != "high" || got.EffortPending || got.DisconnectReason != ReasonClosed {
		t.Errorf("closed %+v", got)
	}
}

// A busy thread keeps its process until the turn ends; then it restarts.
func TestRenderedSetEffortWaitsForTheTurn(t *testing.T) {
	re := newFixtureEnv(t, "write-allow")
	s := re.create(CreateOptions{Effort: "low", PermissionMode: PermissionSupervised, InitialPrompt: "write"})
	re.waitFor(s.ID, "permission", func(s Session) bool { return s.Status == StatusNeedsAttention })
	got, err := re.m.SetEffort(re.ctx(), s.ID, "max")
	if err != nil || !got.EffortPending || got.Effort != "max" {
		t.Fatalf("set effort %+v %v", got, err)
	}
	time.Sleep(50 * time.Millisecond)
	if e := argOf(re.argvOf(), "--effort"); e != "low" {
		t.Fatalf("restarted mid-turn: effort %q", e)
	}
	// Changing it back while busy cancels the change.
	if got, _ = re.m.SetEffort(re.ctx(), s.ID, "low"); got.EffortPending {
		t.Errorf("back to the running effort is still pending")
	}
	if got, _ = re.m.SetEffort(re.ctx(), s.ID, "max"); !got.EffortPending {
		t.Errorf("pending lost")
	}
	p := re.items(s.ID).Pending
	if _, err := re.m.Respond(re.ctx(), s.ID, p[0].RequestID, Decision{Allow: true}); err != nil {
		t.Fatal(err)
	}
	re.waitArgv("the restart after the turn", func(a []string) bool { return argOf(a, "--effort") == "max" })
	re.waitItems(s.ID, "the effort note", hasEffortNote("max"))
	re.waitFor(s.ID, "applied", func(s Session) bool { return !s.EffortPending && s.State == StateConnected })
}

func TestRenderedSetEffortRefusals(t *testing.T) {
	re := newFixtureEnv(t, "text-table")
	s := re.create(CreateOptions{})
	re.waitFor(s.ID, "idle", func(s Session) bool { return s.Status == StatusIdle })
	if _, err := re.m.SetEffort(re.ctx(), s.ID, "huge"); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("bad effort: %v", err)
	}
	if _, err := re.m.SetEffort(re.ctx(), "s-nope", "high"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown thread: %v", err)
	}
	if err := re.m.Close(re.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	// Stopped: the row takes it for the next start, nothing restarts.
	got, err := re.m.SetEffort(re.ctx(), s.ID, "high")
	if err != nil || got.Effort != "high" || got.EffortPending || got.State != StateDisconnected {
		t.Errorf("stopped thread: %+v, %v", got, err)
	}
}

func TestDenyMessage(t *testing.T) {
	tests := []struct {
		reason string
		want   string
	}{
		{"", rejectStop},
		{"   ", rejectStop},
		{"  use the staging branch ", rejectWithReason + "use the staging branch"},
	}
	for _, tt := range tests {
		if got := denyMessage(tt.reason); got != tt.want {
			t.Errorf("denyMessage(%q) = %q, want %q", tt.reason, got, tt.want)
		}
	}
}

// A mode change Claude reports (allow for session applying a setMode suggestion) is
// recorded on the row; modes the app does not offer are ignored.
func TestRenderedFollowsClaudesModeChange(t *testing.T) {
	re := newFixtureEnv(t, "text-table")
	s := re.create(CreateOptions{PermissionMode: PermissionSupervised})
	re.waitFor(s.ID, "idle", func(s Session) bool { return s.Status == StatusIdle })
	re.m.mu.Lock()
	r := re.m.recs[s.ID].run
	re.m.mu.Unlock()
	r.onModeChange("acceptEdits")
	if got, _ := re.m.Get(re.ctx(), s.ID); got.PermissionMode != PermissionAcceptEdits {
		t.Fatalf("mode %v", got.PermissionMode)
	}
	r.onModeChange("plan")
	r.onModeChange("")
	if got, _ := re.m.Get(re.ctx(), s.ID); got.PermissionMode != PermissionAcceptEdits {
		t.Errorf("mode after unknown wire modes %v", got.PermissionMode)
	}
}

// spawnLogs is what each fake process got on stdin, by pid, with its argv.
func (re *env) spawnLogs() map[string]struct {
	argv []string
	sent []map[string]any
} {
	out := map[string]struct {
		argv []string
		sent []map[string]any
	}{}
	paths, _ := filepath.Glob(re.argv + ".*")
	for _, p := range paths {
		pid := strings.TrimPrefix(p, re.argv+".")
		var e struct {
			argv []string
			sent []map[string]any
		}
		if b, err := os.ReadFile(p); err == nil {
			_ = json.Unmarshal(b, &e.argv)
		}
		data, _ := os.ReadFile(re.log + "." + pid)
		for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			var m map[string]any
			if json.Unmarshal([]byte(l), &m) == nil {
				e.sent = append(e.sent, m)
			}
		}
		out[pid] = e
	}
	return out
}

// userTextOf is a user message's text ("" for other lines).
func userTextOf(m map[string]any) string {
	if m["type"] != "user" {
		return ""
	}
	msg, _ := m["message"].(map[string]any)
	content, _ := msg["content"].([]any)
	if len(content) == 0 {
		return ""
	}
	b, _ := content[0].(map[string]any)
	text, _ := b["text"].(string)
	return text
}

// deliveries counts, per spawn (resumed or not), the user messages with text.
func (re *env) deliveries(text string) (fresh, resumed int) {
	for _, e := range re.spawnLogs() {
		for _, m := range e.sent {
			if userTextOf(m) != text {
				continue
			}
			if slices.Contains(e.argv, "--resume") {
				resumed++
			} else {
				fresh++
			}
		}
	}
	return fresh, resumed
}

// waitDeliveries polls deliveries(text) until ok holds or a deadline passes, then
// returns the last counts (the caller reports them).
func (re *env) waitDeliveries(text string, ok func(fresh, resumed int) bool) (fresh, resumed int) {
	re.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		fresh, resumed = re.deliveries(text)
		if ok(fresh, resumed) || time.Now().After(deadline) {
			return fresh, resumed
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// runnerOf is the thread's runner.
func (re *env) runnerOf(id string) *runner {
	re.m.mu.Lock()
	defer re.m.mu.Unlock()
	return re.m.recs[id].run
}

// waitSwapping waits until a restart is replacing the thread's Conn.
func (re *env) waitSwapping(id string) {
	re.t.Helper()
	r := re.runnerOf(id)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := r.st.connection(); err != nil {
			return
		}
		if time.Now().After(deadline) {
			re.t.Fatal("the restart never began")
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// sendAsync sends text on its own goroutine; the result arrives on the channel.
func (re *env) sendAsync(ctx context.Context, id, text string) <-chan error {
	done := make(chan error, 1)
	go func() {
		_, err := re.m.Send(ctx, id, Message{Text: text})
		done <- err
	}()
	return done
}

func waitErr(t *testing.T, what string, ch <-chan error) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(5 * time.Second):
		t.Fatalf("%s never returned", what)
		return nil
	}
}

// What happens to calls made while an effort restart is between processes (the old one
// lingers 400 ms after its stdin closes, so they land in the gap).
func TestRenderedSetEffortGap(t *testing.T) {
	tests := []struct {
		name   string
		env    []string
		mutate func(*Options)
		run    func(t *testing.T, re *env, s Session)
	}{
		{
			name: "a send is held and reaches the new process once",
			run: func(t *testing.T, re *env, s Session) {
				done := re.sendAsync(re.ctx(), s.ID, "held")
				if err := waitErr(t, "the held send", done); err != nil {
					t.Fatalf("send: %v", err)
				}
				re.waitFor(s.ID, "applied", func(s Session) bool { return !s.EffortPending && turnOver(s) })
				// The session can publish the applied state a moment before the held
				// message is written to the new process's stdin: wait for the delivery.
				fresh, resumed := re.waitDeliveries("held", func(fresh, resumed int) bool { return fresh == 0 && resumed == 1 })
				if fresh != 0 || resumed != 1 {
					t.Errorf("held message delivered %d times to the old process, %d to the new", fresh, resumed)
				}
			},
		},
		{
			name: "a send its caller gave up on is dropped",
			run: func(t *testing.T, re *env, s Session) {
				ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
				defer cancel()
				if err := waitErr(t, "the send", re.sendAsync(ctx, s.ID, "gave up")); !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("send: %v", err)
				}
				re.waitFor(s.ID, "applied", func(s Session) bool { return !s.EffortPending && s.State == StateConnected })
				if fresh, resumed := re.deliveries("gave up"); fresh+resumed != 0 {
					t.Errorf("a send that failed was delivered (%d, %d)", fresh, resumed)
				}
				if slices.ContainsFunc(re.items(s.ID).Items, func(it Item) bool { return it.Text == "gave up" }) {
					t.Errorf("a send that failed is in the timeline")
				}
			},
		},
		{
			name: "interrupt, model and mode wait for the new process; respond finds nothing",
			run: func(t *testing.T, re *env, s Session) {
				if err := re.m.Interrupt(re.ctx(), s.ID); !errors.Is(err, ErrFailedPrecondition) {
					t.Errorf("interrupt: %v", err)
				}
				if _, err := re.m.SetModel(re.ctx(), s.ID, "sonnet"); !errors.Is(err, ErrFailedPrecondition) {
					t.Errorf("set model: %v", err)
				}
				if _, err := re.m.SetPermissionMode(re.ctx(), s.ID, PermissionAuto); !errors.Is(err, ErrFailedPrecondition) {
					t.Errorf("set mode: %v", err)
				}
				if _, err := re.m.Respond(re.ctx(), s.ID, "req-1", Decision{Allow: true}); !errors.Is(err, ErrNotFound) {
					t.Errorf("respond: %v", err)
				}
				got := re.waitFor(s.ID, "applied", func(s Session) bool { return !s.EffortPending && s.State == StateConnected })
				if got.Model != "haiku" || got.PermissionMode != PermissionSupervised {
					t.Errorf("refused changes were recorded: %+v", got)
				}
				if _, err := re.m.SetPermissionMode(re.ctx(), s.ID, PermissionAuto); err != nil {
					t.Errorf("set mode after the restart: %v", err)
				}
			},
		},
		{
			// A message is never lost to a close: like a send to a closing thread, the
			// held one waits for the exit and starts the thread again with it.
			name: "a close during the restart: the held send starts the thread again",
			run: func(t *testing.T, re *env, s Session) {
				done := re.sendAsync(re.ctx(), s.ID, "held")
				time.Sleep(20 * time.Millisecond) // the send is on the runner first
				if err := re.m.Close(re.ctx(), s.ID); err != nil {
					t.Fatal(err)
				}
				if err := waitErr(t, "the held send", done); err != nil {
					t.Errorf("held send after close: %v", err)
				}
				got := re.waitFor(s.ID, "started again", func(s Session) bool { return s.State == StateConnected && turnOver(s) })
				if got.Effort != "high" || got.EffortPending {
					t.Errorf("after the start %+v", got)
				}
				if _, resumed := re.waitDeliveries("held", func(_, r int) bool { return r == 1 }); resumed != 1 {
					t.Errorf("held message delivered %d times after the close", resumed)
				}
			},
		},
		{
			name: "daemon shutdown fails the held send; the next spawn uses the new effort",
			run: func(t *testing.T, re *env, s Session) {
				done := re.sendAsync(re.ctx(), s.ID, "held")
				time.Sleep(20 * time.Millisecond)
				re.restart()
				if err := waitErr(t, "the held send", done); err == nil {
					t.Errorf("held send succeeded across a daemon stop")
				}
				got, _ := re.m.Get(re.ctx(), s.ID)
				if got.State != StateDisconnected || got.DisconnectReason != ReasonDaemonStopped || got.Effort != "high" || got.EffortPending {
					t.Errorf("after the daemon restart %+v", got)
				}
				if _, err := re.m.Reconnect(re.ctx(), s.ID); err != nil {
					t.Fatal(err)
				}
				argv := re.waitArgv("the reconnect", func(a []string) bool { return argOf(a, "--resume") != "" && argOf(a, "--effort") == "high" })
				if argOf(argv, "--model") != "haiku" {
					t.Errorf("reconnect argv %q", argv)
				}
				re.waitFor(s.ID, "reconnected", func(s Session) bool { return s.State == StateConnected && !s.EffortPending })
			},
		},
		{
			// The held message is not lost: the thread starts again with it as the first
			// prompt (the fake fails only the first resumed process, CF_FAKE_CLAUDE_ONCE).
			name: "the new process exits before its handshake",
			env:  []string{"CF_FAKE_CLAUDE_RESUME_EXIT=3"},
			run: func(t *testing.T, re *env, s Session) {
				heldItemThenStarted(t, re, s, "Claude did not start: exit code 3: fake claude: cannot resume")
			},
		},
		{
			name:   "the new process never answers its handshake",
			env:    []string{"CF_FAKE_CLAUDE_RESUME_HANG=1"},
			mutate: func(o *Options) { o.StartTimeout = 700 * time.Millisecond },
			run: func(t *testing.T, re *env, s Session) {
				heldItemThenStarted(t, re, s, "Claude did not start: no answer to the initialize handshake after a restart")
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vars := append([]string{"CF_FAKE_CLAUDE_EXIT_DELAY=400ms", "CF_FAKE_CLAUDE_ONCE=" + filepath.Join(t.TempDir(), "once")}, tt.env...)
			var mutate []func(*Options)
			if tt.mutate != nil {
				mutate = append(mutate, tt.mutate)
			}
			re := newFixtureEnvAt(t, fixturePath("text-table"), vars, mutate...)
			s := re.create(CreateOptions{Model: "haiku", Effort: "low", PermissionMode: PermissionSupervised})
			re.waitFor(s.ID, "idle", func(s Session) bool { return s.Status == StatusIdle })
			re.writeTranscript(argOf(re.argvOf(), "--session-id"), userLine("earlier"))
			if _, err := re.m.SetEffort(re.ctx(), s.ID, "high"); err != nil {
				t.Fatal(err)
			}
			re.waitSwapping(s.ID)
			tt.run(t, re, s)
		})
	}
}

// The respawn's argv is the original launch's but for the conversation (--resume, no
// --session-id) and the effort, plus what allow for session granted the old process.
// heldItemThenStarted: an effort restart's new process failed (failText in the
// timeline); the send it held succeeds, the thread starts again with the message as its
// first prompt (one delivery, to a resumed process), and the failed restart's effort note
// never came.
func heldItemThenStarted(t *testing.T, re *env, s Session, failText string) {
	t.Helper()
	it, err := re.m.Send(re.ctx(), s.ID, Message{Text: "held"})
	if err != nil || it.Text != "held" {
		t.Fatalf("held send: %+v, %v", it, err)
	}
	if _, resumed := re.waitDeliveries("held", func(_, r int) bool { return r == 1 }); resumed != 1 {
		t.Errorf("held message delivered %d times", resumed)
	}
	got := re.waitFor(s.ID, "started again", func(s Session) bool { return s.State == StateConnected && turnOver(s) })
	if got.Effort != "high" || got.EffortPending {
		t.Errorf("after the start %+v", got)
	}
	items := re.items(s.ID).Items
	if !slices.ContainsFunc(items, func(x Item) bool { return x.Kind == KindError && strings.HasPrefix(x.Text, failText) }) {
		t.Errorf("no %q item:\n%s", failText, describeItems(items))
	}
	if n := len(userItems(items)); n != 1 {
		t.Errorf("%d user items:\n%s", n, describeItems(items))
	}
	if hasEffortNote("high")(items) {
		t.Errorf("the effort note for a restart that failed")
	}
}

// The restart cannot even exec the new process (claude is gone): the held send still
// returns its item, which stays in the timeline with the failures after it; the thread
// is stopped, and the next message (claude back) starts it.
func TestRenderedSetEffortRespawnExecFails(t *testing.T) {
	link := filepath.Join(t.TempDir(), "claude")
	if err := os.Symlink(fakeClaudeBin, link); err != nil {
		t.Fatal(err)
	}
	re := newFixtureEnvAt(t, fixturePath("text-table"), []string{"CF_FAKE_CLAUDE_EXIT_DELAY=400ms"},
		func(o *Options) { o.Claude = link })
	s := re.create(CreateOptions{Model: "haiku", Effort: "low"})
	re.waitFor(s.ID, "idle", func(s Session) bool { return s.Status == StatusIdle })
	re.writeTranscript(argOf(re.argvOf(), "--session-id"), userLine("earlier"))
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if _, err := re.m.SetEffort(re.ctx(), s.ID, "high"); err != nil {
		t.Fatal(err)
	}
	re.waitSwapping(s.ID)
	it, err := re.m.Send(re.ctx(), s.ID, Message{Text: "held"})
	if err != nil || it.Text != "held" {
		t.Fatalf("held send: %+v, %v", it, err)
	}
	got := re.waitFor(s.ID, "stopped with an error", func(s Session) bool { return s.State == StateDisconnected && s.Status == StatusError })
	if got.StatusReason != ReasonStartFailed || got.Effort != "high" || got.EffortPending {
		t.Errorf("after the failed restart %+v", got)
	}
	items := re.items(s.ID).Items
	u := slices.IndexFunc(items, func(x Item) bool { return x.ID == it.ID })
	if u < 0 || u == len(items)-1 || items[len(items)-1].Kind != KindError ||
		!strings.HasPrefix(items[len(items)-1].Text, "Claude did not start: spawn claude: ") ||
		!slices.ContainsFunc(items[:u], func(x Item) bool { return strings.HasPrefix(x.Text, "Claude did not restart for the effort change") }) {
		t.Errorf("want the restart failure, the message, then the start failure:\n%s", describeItems(items))
	}
	if err := os.Symlink(fakeClaudeBin, link); err != nil {
		t.Fatal(err)
	}
	if _, err := re.m.Send(re.ctx(), s.ID, Message{Text: "again"}); err != nil {
		t.Fatal(err)
	}
	argv := re.waitArgv("the start", func(a []string) bool { return argOf(a, "--effort") == "high" && argOf(a, "--resume") != "" })
	if argOf(argv, "--model") != "haiku" {
		t.Errorf("argv %q", argv)
	}
	re.waitFor(s.ID, "started", func(s Session) bool { return s.State == StateConnected })
}

func TestRenderedSetEffortRespawnArgv(t *testing.T) {
	re := newFixtureEnv(t, "bash")
	s := re.create(CreateOptions{Model: "haiku", Effort: "low", PermissionMode: PermissionAcceptEdits, InitialPrompt: "run it"})
	re.waitFor(s.ID, "permission", func(s Session) bool { return s.Status == StatusNeedsAttention })
	first := re.argvOf()
	re.writeTranscript(argOf(first, "--session-id"), userLine("run it"))
	p := re.items(s.ID).Pending
	if _, err := re.m.Respond(re.ctx(), s.ID, p[0].RequestID, Decision{Allow: true, ForSession: true}); err != nil {
		t.Fatal(err)
	}
	re.waitFor(s.ID, "idle", turnOver)
	if _, err := re.m.SetEffort(re.ctx(), s.ID, "max"); err != nil {
		t.Fatal(err)
	}
	argv := re.waitArgv("the restart", func(a []string) bool { return argOf(a, "--effort") == "max" })
	re.waitFor(s.ID, "applied", func(s Session) bool { return !s.EffortPending && s.State == StateConnected })

	// Everything before the conversation flags and after the effort is the same.
	strip := func(a []string) []string {
		var out []string
		for i := 0; i < len(a); i++ {
			switch a[i] {
			case "--session-id", "--resume", "--effort":
				i++
				continue
			case "--allowedTools":
				for i+1 < len(a) && !strings.HasPrefix(a[i+1], "--") {
					i++
				}
				continue
			}
			out = append(out, a[i])
		}
		return out
	}
	if !slices.Equal(strip(first), strip(argv)) {
		t.Errorf("respawn argv differs beyond the conversation and effort:\n first %q\n again %q", first, argv)
	}
	if argOf(argv, "--resume") != argOf(first, "--session-id") || slices.Contains(argv, "--session-id") || slices.Contains(argv, "--") {
		t.Errorf("respawn argv %q", argv)
	}
	i := slices.Index(argv, "--allowedTools")
	if i < 0 || !slices.Equal(argv[i+1:min(i+3, len(argv))], []string{"Bash(mkdir -p sub)", "Bash(touch sub/a.txt)"}) {
		t.Errorf("the session's grants are not passed again: %q", argv)
	}
}

func TestGrants(t *testing.T) {
	tests := []struct {
		name string
		json []string
		want grants
	}{
		{"nothing", []string{"", "not json", "[]"}, grants{}},
		{"rules", []string{`[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"git push:*"},{"toolName":"WebFetch"}],"behavior":"allow","destination":"session"}]`},
			grants{allow: []string{"Bash(git push:*)", "WebFetch"}}},
		{"deduplicated across answers", []string{
			`[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"ls"}],"behavior":"allow"}]`,
			`[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"ls"}],"behavior":"allow"},{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"rm:*"}],"behavior":"deny"}]`,
		}, grants{allow: []string{"Bash(ls)"}, deny: []string{"Bash(rm:*)"}}},
		{"directories; a mode needs nothing", []string{`[{"type":"addDirectories","directories":["/tmp/x"],"destination":"session"},{"type":"setMode","mode":"acceptEdits"}]`},
			grants{dirs: []string{"/tmp/x"}}},
		{"ask rules are not kept", []string{`[{"type":"addRules","rules":[{"toolName":"Bash"}],"behavior":"ask"}]`}, grants{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var g grants
			for _, j := range tt.json {
				g.add(j)
			}
			if !slices.Equal(g.allow, tt.want.allow) || !slices.Equal(g.deny, tt.want.deny) || !slices.Equal(g.dirs, tt.want.dirs) {
				t.Errorf("grants %+v, want %+v", g, tt.want)
			}
		})
	}
}

// Answering a request Claude already withdrew (an interrupt withdraws what is pending)
// is NotFound, which the GUI shows as a quiet notice; the item stays withdrawn.
func TestRenderedRespondToWithdrawnRequest(t *testing.T) {
	re := newFixtureEnv(t, "interrupt-pending")
	s := re.create(CreateOptions{PermissionMode: PermissionSupervised, InitialPrompt: "write"})
	re.waitFor(s.ID, "permission", func(s Session) bool { return s.Status == StatusNeedsAttention })
	p := re.items(s.ID).Pending[0]
	if err := re.m.Interrupt(re.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	re.waitItems(s.ID, "the request withdrawn", func(items []Item) bool {
		return slices.ContainsFunc(items, func(it Item) bool { return it.Request != nil && it.Request.State == RequestCancelled })
	})
	if _, err := re.m.Respond(re.ctx(), s.ID, p.RequestID, Decision{Allow: true}); !errors.Is(err, ErrNotFound) {
		t.Errorf("respond to a withdrawn request: %v", err)
	}
	items := re.items(s.ID).Items
	i := slices.IndexFunc(items, func(it Item) bool { return it.Request != nil })
	if i < 0 || items[i].Request.State != RequestCancelled || items[i].Request.Message != "withdrawn by Claude" {
		t.Errorf("request item:\n%s", describeItems(items))
	}
}
