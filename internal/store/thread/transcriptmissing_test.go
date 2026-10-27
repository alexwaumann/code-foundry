package thread

import (
	"bytes"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Threads whose transcript Claude Code deleted (transcriptmissing.go).

func TestNeedsTranscript(t *testing.T) {
	tests := []struct {
		name string
		s    Thread
		want bool
	}{
		{name: "a saved conversation", s: Thread{ClaudeSessionID: "c1"}, want: true},
		{name: "no message sent yet", s: Thread{}},
		{name: "a reseed's fresh start", s: Thread{ClaudeSessionID: "c1", FreshStart: true}},
		{name: "a resident thread starts over", s: Thread{ClaudeSessionID: "c1", Kind: KindResident}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.s.needsTranscript(); got != tt.want {
				t.Errorf("needsTranscript = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestTranscriptIndex(t *testing.T) {
	dir := t.TempDir()
	paths := ClaudePaths{Dir: dir}
	cwd := filepath.Join(dir, "wt")
	write := func(slug, id string) {
		t.Helper()
		d := filepath.Join(dir, "projects", slug)
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, id+".jsonl"), []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(projectSlug(realPath(cwd)), "direct")
	write("-shortened-slug", "elsewhere")
	x := &transcriptIndex{paths: paths}
	tests := []struct {
		name string
		s    Thread
		want bool
	}{
		{name: "in the cwd's project dir", s: Thread{WorktreePath: cwd, ClaudeSessionID: "direct"}},
		{name: "in another project dir", s: Thread{WorktreePath: cwd, ClaudeSessionID: "elsewhere"}},
		{name: "deleted", s: Thread{WorktreePath: cwd, ClaudeSessionID: "deleted"}, want: true},
		{name: "deleted but fresh", s: Thread{WorktreePath: cwd, ClaudeSessionID: "deleted", FreshStart: true}},
		{name: "no conversation", s: Thread{WorktreePath: cwd}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := x.gone(tt.s); got != tt.want {
				t.Errorf("gone = %v, want %v", got, tt.want)
			}
		})
	}
}

// deadThread is a thread that ran a turn, stopped, and whose transcript was then
// deleted (as Claude Code's cleanupPeriodDays does). Not flagged yet: the transcript
// went after the stop's check.
func (e *env) deadThread() (Thread, string) {
	e.t.Helper()
	s := e.create(CreateOptions{InitialPrompt: "first"})
	e.waitItems(s.ID, "the first turn", turnCount(1))
	e.resumable(s.ID)
	cid := e.snapshot(s.ID).ClaudeSessionID
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		e.t.Fatal(err)
	}
	got := e.waitFor(s.ID, "stopped", stopped)
	if got.TranscriptMissing {
		e.t.Fatalf("flagged with its transcript there: %+v", got)
	}
	e.deleteTranscript(cid)
	return got, cid
}

func (e *env) deleteTranscript(cid string) {
	e.t.Helper()
	if err := os.Remove(filepath.Join(e.paths.projectDir(e.wt), cid+".jsonl")); err != nil {
		e.t.Fatal(err)
	}
}

// Every way to make a dead thread's Claude run is refused with the one message,
// leaves its timeline and status as they were, spawns nothing, and flags the thread.
func TestTranscriptMissingRefuses(t *testing.T) {
	tests := []struct {
		name string
		call func(e *env, id string) error
	}{
		{name: "send", call: func(e *env, id string) error {
			_, err := e.m.Send(e.ctx(), id, Message{Text: "again"})
			return err
		}},
		{name: "reconnect", call: func(e *env, id string) error {
			_, err := e.m.Reconnect(e.ctx(), id)
			return err
		}},
		{name: "mcp refresh", call: func(e *env, id string) error {
			_, err := e.m.McpStatus(e.ctx(), id, true)
			return err
		}},
		{name: "fork", call: func(e *env, id string) error {
			_, err := e.m.Fork(e.ctx(), id, "")
			return err
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			s, _ := e.deadThread()
			before := e.items(s.ID).Items
			spawns := e.spawnCount()

			err := tt.call(e, s.ID)
			if !errors.Is(err, ErrTranscriptMissing) || !errors.Is(err, ErrFailedPrecondition) {
				t.Fatalf("err = %v, want ErrTranscriptMissing", err)
			}
			if !strings.Contains(err.Error(), "cleanupPeriodDays") {
				t.Errorf("message %q", err)
			}
			got := e.snapshot(s.ID)
			if !got.TranscriptMissing || got.State != StateDisconnected || got.Status != s.Status || got.StatusReason != s.StatusReason {
				t.Errorf("after the refusal %+v (was %s %q)", got, s.Status, s.StatusReason)
			}
			if n := e.spawnCount() - spawns; n != 0 {
				t.Errorf("%d processes started", n)
			}
			if after := e.items(s.ID).Items; len(after) != len(before) {
				t.Errorf("items %d -> %d\n%s", len(before), len(after), describeItems(after))
			}
			// Flagged now: the queries that need no start refuse too.
			if _, err := e.m.SlashCommands(e.ctx(), s.ID); !errors.Is(err, ErrTranscriptMissing) {
				t.Errorf("slash commands: %v", err)
			}
			if _, err := e.m.McpStatus(e.ctx(), s.ID, false); !errors.Is(err, ErrTranscriptMissing) {
				t.Errorf("mcp status: %v", err)
			}
			if _, err := e.m.McpReconnect(e.ctx(), s.ID, "srv"); !errors.Is(err, ErrTranscriptMissing) {
				t.Errorf("mcp reconnect: %v", err)
			}
		})
	}
}

// A transcript put back clears the flag at the next send, which resumes it.
func TestTranscriptMissingRestored(t *testing.T) {
	e := newEnv(t)
	s, cid := e.deadThread()
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); !errors.Is(err, ErrTranscriptMissing) {
		t.Fatalf("send: %v", err)
	}
	e.writeTranscript(cid, userLine("hi"))
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "back"}); err != nil {
		t.Fatal(err)
	}
	e.waitDeliveries("back", func(f, r int) bool { return r == 1 })
	if argOf(e.argvOf(), "--resume") != cid {
		t.Errorf("argv %q", e.argvOf())
	}
	if got := e.snapshot(s.ID); got.TranscriptMissing {
		t.Errorf("still flagged: %+v", got)
	}
}

// Reseed is the route that starts over: the flag goes, and the next message starts a
// new conversation. Archive and remove work on a dead thread.
func TestTranscriptMissingReseedArchiveRemove(t *testing.T) {
	e := newEnv(t)
	s, cid := e.deadThread()
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); !errors.Is(err, ErrTranscriptMissing) {
		t.Fatalf("send: %v", err)
	}
	r, stoppedNow, err := e.m.Reseed(e.ctx(), s.ID, ReseedOptions{})
	if err != nil || stoppedNow || r.TranscriptMissing || !r.FreshStart {
		t.Fatalf("Reseed = %+v %v %v", r, stoppedNow, err)
	}
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "over"}); err != nil {
		t.Fatal(err)
	}
	e.waitDeliveries("over", func(f, r int) bool { return f == 1 })
	argv := e.argvOf()
	if argOf(argv, "--resume") != "" || argOf(argv, "--session-id") == "" || argOf(argv, "--session-id") == cid {
		t.Errorf("argv %q", argv)
	}

	d, _ := e.deadThread()
	if _, err := e.m.Send(e.ctx(), d.ID, Message{Text: "again"}); !errors.Is(err, ErrTranscriptMissing) {
		t.Fatalf("send: %v", err)
	}
	if a, err := e.m.Archive(e.ctx(), d.ID, true); err != nil || a.ArchivedAt.IsZero() {
		t.Fatalf("Archive = %+v, %v", a, err)
	}
	if err := e.m.Remove(e.ctx(), d.ID); err != nil {
		t.Fatalf("Remove: %v", err)
	}
}

// The flag is computed at daemon start (for every stopped thread) and when the process
// ends, not only when a start is refused.
func TestTranscriptMissingComputed(t *testing.T) {
	e := newEnv(t)
	alive := e.create(CreateOptions{InitialPrompt: "first"})
	e.waitItems(alive.ID, "the first turn", turnCount(1))
	e.resumable(alive.ID)
	dead, _ := e.deadThread()

	// On disconnect: the transcript goes while Claude runs, then it exits.
	running := e.create(CreateOptions{InitialPrompt: "first"})
	e.waitItems(running.ID, "the first turn", turnCount(1))
	e.resumable(running.ID)
	e.deleteTranscript(e.snapshot(running.ID).ClaudeSessionID)
	e.exit(running.ID, 0)
	if got := e.waitFor(running.ID, "stopped", stopped); !got.TranscriptMissing {
		t.Errorf("not flagged on disconnect: %+v", got)
	}

	// At start.
	e.restart()
	for _, tt := range []struct {
		id   string
		want bool
	}{{alive.ID, false}, {dead.ID, true}, {running.ID, true}} {
		if got := e.snapshot(tt.id); got.TranscriptMissing != tt.want {
			t.Errorf("%s after a restart: TranscriptMissing %v, want %v", tt.id, got.TranscriptMissing, tt.want)
		}
	}
}

// syncBuffer is a log sink the daemon's goroutines write while the test reads.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// A wake to a dead subscriber is not delivered: logged, nothing in its timeline, no
// start.
func TestTranscriptMissingWake(t *testing.T) {
	clk := newTestClock()
	var logs syncBuffer
	e := newEnv(t, clk.opts(), timerOpts, func(o *Options) { o.Log = slog.New(slog.NewTextHandler(&logs, nil)) })
	s, _ := e.deadThread()
	before := len(e.items(s.ID).Items)
	spawns := e.spawnCount()
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: s.ID, TargetAt: clk.Now().Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}
	clk.advance(2 * time.Minute)
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(logs.String(), "wake not delivered") {
		if time.Now().After(deadline) {
			t.Fatalf("no log of the wake\n%s", logs.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !strings.Contains(logs.String(), "cleanupPeriodDays") {
		t.Errorf("the log does not say why\n%s", logs.String())
	}
	if n := len(e.items(s.ID).Items); n != before {
		t.Errorf("items %d -> %d", before, n)
	}
	if n := e.spawnCount() - spawns; n != 0 {
		t.Errorf("%d processes started", n)
	}
	if got := e.snapshot(s.ID); !got.TranscriptMissing || got.State != StateDisconnected {
		t.Errorf("after the wake %+v", got)
	}
}
