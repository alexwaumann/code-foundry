package terminal

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	ghostty "go.mitchellh.com/libghostty"

	"github.com/awaumann/code-foundry/internal/bus"
)

func newTestManager(t *testing.T, opts Options) *Manager {
	t.Helper()
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	m := New(opts)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := m.Close(ctx); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return m
}

func testCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// collector reads an Attach channel in the background and replays everything into a
// libghostty terminal, the way the GUI's xterm.js would.
type collector struct {
	mu      sync.Mutex
	events  []AttachEvent
	raw     bytes.Buffer
	closed  bool
	changed chan struct{}
}

func collect(ch <-chan AttachEvent) *collector {
	c := &collector{changed: make(chan struct{}, 1)}
	go func() {
		for ev := range ch {
			c.mu.Lock()
			c.events = append(c.events, ev)
			switch {
			case ev.Snapshot != nil:
				c.raw.Write(ev.Snapshot.Data)
			case ev.Output != nil:
				c.raw.Write(ev.Output)
			}
			c.mu.Unlock()
			c.signal()
		}
		c.mu.Lock()
		c.closed = true
		c.mu.Unlock()
		c.signal()
	}()
	return c
}

func (c *collector) signal() {
	select {
	case c.changed <- struct{}{}:
	default:
	}
}

// waitFor polls cond under the lock until it is true or the deadline passes.
func (c *collector) waitFor(t *testing.T, what string, cond func(c *collector) bool) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		c.mu.Lock()
		ok := cond(c)
		c.mu.Unlock()
		if ok {
			return
		}
		select {
		case <-c.changed:
		case <-time.After(20 * time.Millisecond):
		case <-deadline:
			c.mu.Lock()
			defer c.mu.Unlock()
			t.Fatalf("timed out waiting for %s; raw=%q events=%d closed=%v", what, c.raw.String(), len(c.events), c.closed)
		}
	}
}

func (c *collector) exited() *Exit {
	for _, ev := range c.events {
		if ev.Exited != nil {
			return ev.Exited
		}
	}
	return nil
}

func rawContains(s string) func(*collector) bool {
	return func(c *collector) bool { return strings.Contains(c.raw.String(), s) }
}

// screenText replays raw into a fresh emulator and returns its plain-text dump.
func screenText(t *testing.T, raw []byte, cols, rows uint16) string {
	t.Helper()
	term := newTestVT(t, cols, rows)
	term.VTWrite(raw)
	out, err := format(term, ghostty.WithFormatterFormat(ghostty.FormatterFormatPlain))
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func TestPrintfOutputAndExit(t *testing.T) {
	ctx := testCtx(t)
	b := bus.New()
	updates := bus.Subscribe[TerminalUpdated](b, 64)
	defer updates.Close()
	m := newTestManager(t, Options{Bus: b})

	term, err := m.Create(ctx, Spec{
		Argv:   []string{"/bin/sh", "-c", `printf '\033]2;my title\007\033[1;31mred\033[0m plain\r\n'; sleep 0.3; exit 3`},
		Cols:   60,
		Rows:   10,
		Labels: map[string]string{"k": "v"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if term.State != StateRunning || term.Pid == 0 || term.Labels["k"] != "v" || term.Cols != 60 {
		t.Fatalf("Create = %+v", term)
	}
	ch, err := m.Attach(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	c := collect(ch)
	c.waitFor(t, "exit", func(c *collector) bool { return c.exited() != nil })

	c.mu.Lock()
	if c.events[0].Snapshot == nil {
		t.Errorf("first event = %+v, want Snapshot", c.events[0])
	}
	if code := c.exited().Code; code != 3 {
		t.Errorf("exit code = %d, want 3", code)
	}
	raw := c.raw.Bytes()
	c.mu.Unlock()
	if text := screenText(t, raw, 60, 10); !strings.Contains(text, "red plain") {
		t.Errorf("replayed screen = %q, want it to contain %q", text, "red plain")
	}

	got, err := m.Get(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != StateExited || got.ExitCode != 3 || got.Title != "my title" || got.ExitedAt.IsZero() {
		t.Errorf("Get after exit = %+v", got)
	}

	// The bus saw the create, the title, and the exit.
	var sawTitle, sawExit bool
	for !sawExit {
		select {
		case u := <-updates.C():
			sawTitle = sawTitle || u.Terminal.Title == "my title"
			sawExit = u.Terminal.State == StateExited
		case <-ctx.Done():
			t.Fatal("no exit update on bus")
		}
	}
	if !sawTitle {
		t.Error("no title update on bus")
	}

	// The final screen stays attachable until Remove.
	ch2, err := m.Attach(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	c2 := collect(ch2)
	c2.waitFor(t, "snapshot+exited", func(c *collector) bool { return len(c.events) >= 2 })
	c2.mu.Lock()
	if c2.events[0].Snapshot == nil || c2.events[1].Exited == nil || c2.events[1].Exited.Code != 3 {
		t.Errorf("re-attach events = %+v", c2.events)
	}
	if text := screenText(t, c2.raw.Bytes(), 60, 10); !strings.Contains(text, "red plain") {
		t.Errorf("re-attach snapshot screen = %q", text)
	}
	c2.mu.Unlock()

	if err := m.Remove(ctx, term.ID); err != nil {
		t.Fatal(err)
	}
	c.waitFor(t, "first attach closed", func(c *collector) bool { return c.closed })
	c2.waitFor(t, "second attach closed", func(c *collector) bool { return c.closed })
	if _, err := m.Get(ctx, term.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get after Remove err = %v, want ErrNotFound", err)
	}
}

func TestCatEchoesWrites(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/cat"}, Cols: 40, Rows: 5})
	if err != nil {
		t.Fatal(err)
	}
	ch, err := m.Attach(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	c := collect(ch)
	if err := m.Write(ctx, term.ID, []byte("hello cat\n")); err != nil {
		t.Fatal(err)
	}
	// The tty echoes the input, then cat prints the line: "hello cat" twice.
	c.waitFor(t, "echo + cat output", func(c *collector) bool {
		return strings.Count(c.raw.String(), "hello cat") >= 2
	})

	if err := m.Remove(ctx, term.ID); !errors.Is(err, ErrRunning) {
		t.Fatalf("Remove running err = %v, want ErrRunning", err)
	}
	// ^D at the start of a line ends cat normally.
	if err := m.Write(ctx, term.ID, []byte{4}); err != nil {
		t.Fatal(err)
	}
	c.waitFor(t, "exit", func(c *collector) bool { return c.exited() != nil })
	if code := c.exited().Code; code != 0 {
		t.Errorf("exit code = %d, want 0", code)
	}
	if err := m.Write(ctx, term.ID, []byte("late")); !errors.Is(err, ErrExited) {
		t.Errorf("Write after exit err = %v, want ErrExited", err)
	}
}

func TestQueryRepliesReachProgram(t *testing.T) {
	// The program asks for the cursor position (DSR 6) and DA1, reads the replies with
	// the tty in raw mode, and prints them hex-escaped. Only the emulator can answer.
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	script := `stty raw -echo; printf 'ab\033[6n\033[c'; r=$(dd bs=1 count=15 2>/dev/null | od -An -c | tr -d ' \n'); stty sane; printf '\r\nREPLY:%s\r\n' "$r"`
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", script}, Cols: 40, Rows: 5})
	if err != nil {
		t.Fatal(err)
	}
	ch, err := m.Attach(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	c := collect(ch)
	c.waitFor(t, "exit", func(c *collector) bool { return c.exited() != nil })
	c.mu.Lock()
	defer c.mu.Unlock()
	// DSR reply ESC[1;3R (row 1, col 3), then DA1 ESC[?62;22c.
	if !strings.Contains(c.raw.String(), `REPLY:033[1;3R033[?62;22c`) {
		t.Errorf("program did not receive DSR + DA replies; raw = %q", c.raw.String())
	}
}

func TestResize(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	// Print the size the program sees after each SIGWINCH.
	script := `trap 'printf "SIZE:%s\r\n" "$(stty size)"' WINCH; printf 'ready\r\n'; while :; do sleep 0.05; done`
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", script}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	ch, err := m.Attach(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	c := collect(ch)
	c.waitFor(t, "ready", rawContains("ready"))
	if err := m.Resize(ctx, term.ID, 100, 30); err != nil {
		t.Fatal(err)
	}
	c.waitFor(t, "SIGWINCH size", rawContains("SIZE:30 100"))
	c.mu.Lock()
	var resized *Size
	for _, ev := range c.events {
		if ev.Resized != nil {
			resized = ev.Resized
		}
	}
	c.mu.Unlock()
	if resized == nil || *resized != (Size{Cols: 100, Rows: 30}) {
		t.Errorf("Resized event = %+v", resized)
	}
	got, _ := m.Get(ctx, term.ID)
	if got.Cols != 100 || got.Rows != 30 {
		t.Errorf("Get size = %dx%d", got.Cols, got.Rows)
	}
	if err := m.Resize(ctx, term.ID, 0, 10); !errors.Is(err, ErrInvalidSpec) {
		t.Errorf("Resize 0 cols err = %v", err)
	}
	// A new attach sees the new size in its snapshot.
	ch2, err := m.Attach(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	snap := (<-ch2).Snapshot
	if snap == nil || snap.Cols != 100 || snap.Rows != 30 {
		t.Errorf("snapshot after resize = %+v", snap)
	}
}

func TestKillEscalatesToSIGKILL(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{KillGrace: 200 * time.Millisecond})
	tests := []struct {
		name     string
		script   string
		wantCode int
	}{
		{"honours SIGHUP", `printf 'up\r\n'; while :; do sleep 0.05; done`, 128 + 1},
		{"ignores SIGHUP", `trap '' HUP; printf 'up\r\n'; while :; do sleep 0.05; done`, 128 + 9},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", tt.script}})
			if err != nil {
				t.Fatal(err)
			}
			ch, err := m.Attach(ctx, term.ID)
			if err != nil {
				t.Fatal(err)
			}
			c := collect(ch)
			c.waitFor(t, "up", rawContains("up"))
			start := time.Now()
			if err := m.Kill(ctx, term.ID); err != nil {
				t.Fatal(err)
			}
			c.waitFor(t, "exit", func(c *collector) bool { return c.exited() != nil })
			if code := c.exited().Code; code != tt.wantCode {
				t.Errorf("exit code = %d, want %d (after %v)", code, tt.wantCode, time.Since(start))
			}
			if err := m.Kill(ctx, term.ID); err != nil {
				t.Errorf("second Kill = %v, want nil", err)
			}
			if err := m.Remove(ctx, term.ID); err != nil {
				t.Error(err)
			}
		})
	}
}

func TestBackgroundChildHoldingPTYDoesNotBlockExit(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	// The background sleep keeps the slave open after sh exits.
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", `(trap '' HUP; sleep 2) & printf 'bye\r\n'; exit 7`}})
	if err != nil {
		t.Fatal(err)
	}
	ch, err := m.Attach(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	c := collect(ch)
	start := time.Now()
	c.waitFor(t, "exit", func(c *collector) bool { return c.exited() != nil })
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("exit took %v", d)
	}
	if code := c.exited().Code; code != 7 {
		t.Errorf("exit code = %d, want 7", code)
	}
}

func TestAttachSnapshotThenLiveOutputHasNoGapOrDuplicate(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	// A steady counter; attaching mid-stream must replay to a screen that continues
	// seamlessly: every number appears exactly once, in order.
	script := `i=0; while [ $i -lt 400 ]; do printf '%d ' $i; i=$((i+1)); done; printf '\r\nDONE\r\n'; sleep 0.2`
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", script}, Cols: 80, Rows: 60})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond) // attach while output is flowing
	ch, err := m.Attach(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	c := collect(ch)
	c.waitFor(t, "exit", func(c *collector) bool { return c.exited() != nil })
	c.mu.Lock()
	raw := append([]byte(nil), c.raw.Bytes()...)
	c.mu.Unlock()

	// Whitespace-insensitive: where rows break depends on timing, the digits must not.
	var want strings.Builder
	for i := range 400 {
		want.WriteString(strconv.Itoa(i))
	}
	want.WriteString("DONE")
	got := strings.Join(strings.Fields(screenText(t, raw, 80, 60)), "")
	if !strings.Contains(got, want.String()) {
		t.Errorf("replayed stream is not contiguous:\n%s", got)
	}
}

func TestSlowSubscriberIsDropped(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{SubscriberBuffer: 4})
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", `i=0; while [ $i -lt 2000 ]; do echo line $i; i=$((i+1)); done; sleep 5`}})
	if err != nil {
		t.Fatal(err)
	}
	ch, err := m.Attach(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Do not read until the producer has certainly overrun 4 slots.
	deadline := time.After(5 * time.Second)
	for m.DroppedSubscribers() == 0 {
		select {
		case <-deadline:
			t.Fatal("subscriber was never dropped")
		case <-time.After(10 * time.Millisecond):
		}
	}
	var last AttachEvent
	n := 0
	for ev := range ch {
		last = ev
		n++
	}
	if !last.Dropped || n != 4 {
		t.Errorf("got %d events, last = %+v; want 4 ending in Dropped", n, last)
	}
	// The terminal itself is unaffected and a fresh attach works.
	ch2, err := m.Attach(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ev := <-ch2; ev.Snapshot == nil {
		t.Errorf("re-attach first event = %+v", ev)
	}
	_ = m.Kill(ctx, term.ID)
}

func TestDetachOnContextCancel(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/cat"}})
	if err != nil {
		t.Fatal(err)
	}
	actx, cancel := context.WithCancel(ctx)
	ch, err := m.Attach(actx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	<-ch // snapshot
	cancel()
	select {
	case _, ok := <-ch:
		if ok {
			// Output may race the cancel; drain until closed.
			for range ch {
			}
		}
	case <-time.After(5 * time.Second):
		t.Fatal("attach channel not closed after cancel")
	}
}

func TestAltScreenAndTitleMetadata(t *testing.T) {
	ctx := testCtx(t)
	b := bus.New()
	updates := bus.Subscribe[TerminalUpdated](b, 256)
	defer updates.Close()
	m := newTestManager(t, Options{Bus: b, MetadataInterval: 50 * time.Millisecond})
	// 50 title changes in a burst, then enter the alternate screen and stay there.
	script := `i=0; while [ $i -lt 50 ]; do printf '\033]2;t%d\007' $i; i=$((i+1)); done; printf '\033[?1049h\033[HALT UI'; sleep 5`
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", script}})
	if err != nil {
		t.Fatal(err)
	}
	var n int
	var last Terminal
	timeout := time.After(5 * time.Second)
	for last.Title != "t49" || !last.AltScreen {
		select {
		case u := <-updates.C():
			if u.Terminal.ID == term.ID {
				n++
				last = u.Terminal
			}
		case <-timeout:
			t.Fatalf("final state never published; last = %+v", last)
		}
	}
	// Create + at most a few throttled updates, not 50.
	if n > 10 {
		t.Errorf("published %d updates for a burst of 50 title changes", n)
	}
	ch, err := m.Attach(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	snap := (<-ch).Snapshot
	if snap == nil || !snap.AltScreen {
		t.Fatalf("snapshot = %+v, want alt screen", snap)
	}
	if text := screenText(t, snap.Data, snap.Cols, snap.Rows); !strings.Contains(text, "ALT UI") {
		t.Errorf("alt snapshot screen = %q", text)
	}
	_ = m.Kill(ctx, term.ID)
}

func TestCreateValidation(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	file := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		spec Spec
	}{
		{"empty argv", Spec{}},
		{"unknown program", Spec{Argv: []string{"definitely-not-a-program-cf"}}},
		{"cwd missing", Spec{Argv: []string{"/bin/sh"}, Cwd: "/nonexistent/dir"}},
		{"cwd is a file", Spec{Argv: []string{"/bin/sh"}, Cwd: file}},
		{"too wide", Spec{Argv: []string{"/bin/sh"}, Cols: 10000}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := m.Create(ctx, tt.spec); !errors.Is(err, ErrInvalidSpec) {
				t.Errorf("err = %v, want ErrInvalidSpec", err)
			}
		})
	}
	if len(m.List(ctx)) != 0 {
		t.Error("failed creates left terminals behind")
	}
}

func TestEnvCwdAndList(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CF_TEST_INHERITED", "yes")
	t.Setenv("CF_TEST_REMOVED", "should-not-see")
	term, err := m.Create(ctx, Spec{
		Argv: []string{"sh", "-c", `printf '%s|%s|%s|%s|%s\r\n' "$PWD" "$CF_TEST_SET" "$CF_TEST_INHERITED" "${CF_TEST_REMOVED-unset}" "$TERM"`},
		Cwd:  dir,
		Env:  []string{"CF_TEST_SET=1", "CF_TEST_REMOVED"},
	})
	if err != nil {
		t.Fatal(err)
	}
	ch, err := m.Attach(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	c := collect(ch)
	want := dir + "|1|yes|unset|xterm-256color"
	c.waitFor(t, want, rawContains(want))

	second, err := m.Create(ctx, Spec{Argv: []string{"/bin/cat"}})
	if err != nil {
		t.Fatal(err)
	}
	list := m.List(ctx)
	if len(list) != 2 || list[0].ID != term.ID || list[1].ID != second.ID {
		t.Errorf("List = %+v", list)
	}
}

func TestWatch(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	events, err := m.Watch(ctx)
	if err != nil {
		t.Fatal(err)
	}
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", "exit 0"}})
	if err != nil {
		t.Fatal(err)
	}
	var sawCreate, sawExit, sawRemove bool
	for !sawRemove {
		select {
		case ev := <-events:
			switch {
			case ev.Updated != nil && ev.Updated.ID == term.ID && ev.Updated.State == StateRunning:
				sawCreate = true
			case ev.Updated != nil && ev.Updated.ID == term.ID && ev.Updated.State == StateExited:
				sawExit = true
				if err := m.Remove(ctx, term.ID); err != nil {
					t.Fatal(err)
				}
			case ev.RemovedID == term.ID:
				sawRemove = true
			}
		case <-ctx.Done():
			t.Fatalf("watch: create=%v exit=%v remove=%v", sawCreate, sawExit, sawRemove)
		}
	}
	if !sawCreate || !sawExit {
		t.Errorf("watch: create=%v exit=%v", sawCreate, sawExit)
	}
}

func TestOperationsOnUnknownID(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{})
	checks := map[string]error{}
	_, checks["Get"] = m.Get(ctx, "nope")
	checks["Write"] = m.Write(ctx, "nope", []byte("x"))
	checks["Resize"] = m.Resize(ctx, "nope", 10, 10)
	checks["Kill"] = m.Kill(ctx, "nope")
	checks["Remove"] = m.Remove(ctx, "nope")
	_, checks["Attach"] = m.Attach(ctx, "nope")
	for op, err := range checks {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s err = %v, want ErrNotFound", op, err)
		}
	}
}

func TestScrollbackRetainedAndCompressedWhenIdle(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{MaxScrollbackLines: 3000, CompressAfter: 100 * time.Millisecond})
	// ~170 KB of output: far beyond libghostty's 10,000-byte default scrollback cap.
	script := `i=0; while [ $i -lt 4000 ]; do echo "line $i of a long enough log message"; i=$((i+1)); done; sleep 30`
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", script}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	a, err := m.actor(term.ID)
	if err != nil {
		t.Fatal(err)
	}
	var rows uint
	var mu ghostty.MemoryUsage
	deadline := time.Now().Add(8 * time.Second)
	for {
		if err := a.call(ctx, func() {
			rows, _ = a.vt.ScrollbackRows()
			mu, _ = a.vt.MemoryUsage()
		}); err != nil {
			t.Fatal(err)
		}
		// The line limit is page-granular (~2800 of 3000 kept); the byte-cap trap would leave ~500.
		if rows >= 2500 && mu.Primary.CompressedPages > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("scrollback rows = %d, compressed pages = %d (supported=%v)", rows, mu.Primary.CompressedPages, mu.CompressionSupported)
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Logf("scrollback rows %d, resident %d KiB, %d/%d pages compressed",
		rows, mu.Primary.ResidentBytes>>10, mu.Primary.CompressedPages, mu.Primary.Pages)

	// Compressed history still serializes.
	ch, err := m.Attach(ctx, term.ID)
	if err != nil {
		t.Fatal(err)
	}
	snap := (<-ch).Snapshot
	if !bytes.Contains(snap.Data, []byte("line 1500 of")) {
		t.Errorf("snapshot (%d bytes) lacks compressed history", len(snap.Data))
	}
	_ = m.Kill(ctx, term.ID)
}
