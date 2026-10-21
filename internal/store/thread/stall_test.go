package thread

import (
	"context"
	"errors"
	"strings"
	"syscall"
	"testing"
	"time"
)

// newStallEnv is an env whose claude gets stuck in its first turn
// (CF_FAKE_CLAUDE_STALL): it stops reading stdin and ignores SIGTERM.
func newStallEnv(t *testing.T, mutate ...func(*Options)) (*env, Thread) {
	t.Helper()
	e := newFixtureEnvAt(t, fixturePath("text-table"), []string{"CF_FAKE_CLAUDE_STALL=1"}, mutate...)
	s := e.create(CreateOptions{InitialPrompt: "hang"})
	e.waitFor(s.ID, "the stuck turn", func(s Thread) bool { return s.State == StateConnected && s.Status == StatusBusy })
	return e, s
}

// Control requests for a caller are bounded (Options.ControlTimeout): a Claude that
// never answers fails them with a clear error instead of holding the caller forever.
func TestControlCallsToAStuckClaude(t *testing.T) {
	e, s := newStallEnv(t, func(o *Options) { o.ControlTimeout = 300 * time.Millisecond })
	tests := []struct {
		name, what string
		call       func() error
	}{
		{"interrupt", "interrupt", func() error { return e.m.Interrupt(e.ctx(), s.ID, "") }},
		{"permission mode", "permission mode change", func() error {
			_, err := e.m.SetPermissionMode(e.ctx(), s.ID, PermissionAcceptEdits)
			return err
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			start := time.Now()
			err := tt.call()
			var na *NoAnswerError
			if !errors.As(err, &na) || !errors.Is(err, context.DeadlineExceeded) ||
				!strings.Contains(err.Error(), "Claude did not answer the "+tt.what+" within 300ms") {
				t.Errorf("err = %v", err)
			}
			if took := time.Since(start); took > 3*time.Second {
				t.Errorf("took %s", took)
			}
		})
	}
	if got := e.snapshot(s.ID); got.PermissionMode == PermissionAcceptEdits {
		t.Error("the row took a mode Claude never confirmed")
	}
}

// A message Claude does not read (bigger than the pipe's buffer, to a Claude stuck
// mid-turn) fails at Options.SendTimeout instead of freezing the runner: the thread
// says why and closes, SIGKILL ending the process that ignores SIGTERM, and archiving
// it works.
func TestSendToAStuckClaude(t *testing.T) {
	e, s := newStallEnv(t, func(o *Options) { o.SendTimeout, o.CloseTimeout = 300*time.Millisecond, 300*time.Millisecond })
	pid := e.pid(s.ID)
	start := time.Now()
	_, err := e.m.Send(e.ctx(), s.ID, Message{Text: strings.Repeat("y", 1<<20)})
	if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "Claude stopped reading its input") {
		t.Errorf("send: %v", err)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Errorf("the send took %s", took)
	}
	e.waitFor(s.ID, "the close", func(s Thread) bool { return s.State == StateDisconnected })
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Errorf("claude %d still runs: %v", pid, err)
	}
	if last, ok := lastKind(e.items(s.ID).Items, KindError); !ok || !strings.HasPrefix(last.Text, "Claude stopped reading its input") {
		t.Errorf("items:\n%s", describeItems(e.items(s.ID).Items))
	}
	if _, err := e.m.Archive(e.ctx(), s.ID, true); err != nil {
		t.Errorf("archive: %v", err)
	}
}

// Shutdown kills the process of a runner still stuck at its deadline: claude never
// outlives the daemon.
func TestShutdownKillsAStuckRunner(t *testing.T) {
	e, s := newStallEnv(t, func(o *Options) { o.SendTimeout = time.Minute })
	pid := e.pid(s.ID)
	go func() { _, _ = e.m.Send(context.Background(), s.ID, Message{Text: strings.Repeat("y", 1<<20)}) }()
	time.Sleep(200 * time.Millisecond) // the runner is in the write
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	if err := e.m.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("shutdown: %v, want the deadline", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			t.Fatalf("claude %d outlived the shutdown", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
