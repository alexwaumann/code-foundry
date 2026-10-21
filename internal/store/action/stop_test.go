package action

import (
	"context"
	"errors"
	"syscall"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

func TestStopRun(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, func(o *Options) { o.KillGrace = 300 * time.Millisecond })
	h.create(CreateOptions{ProjectID: "web", Name: "Forever", Command: "echo started; sleep 30"})
	h.create(CreateOptions{ProjectID: "web", Name: "Shell", Command: "sleep 30", InTerminal: true})

	t.Run("background", func(t *testing.T) {
		r, err := h.m.Run(ctx, RunOptions{Action: "forever", Worktree: h.web})
		if err != nil {
			t.Fatal(err)
		}
		got, err := h.m.StopRun(ctx, r.ID)
		if err != nil || got.ID != r.ID {
			t.Fatalf("StopRun = %+v, %v", got, err)
		}
		if done := h.wait(r.ID); done.ExitCode != 128+int(syscall.SIGTERM) {
			t.Errorf("exit = %d, want the SIGTERM's", done.ExitCode)
		}
		// A finished run: nothing to do.
		if again, err := h.m.StopRun(ctx, r.ID); err != nil || again.State != RunExited {
			t.Errorf("StopRun after the end = %+v, %v", again, err)
		}
	})
	t.Run("terminal", func(t *testing.T) {
		r, err := h.m.Run(ctx, RunOptions{Action: "shell", Worktree: h.web})
		if err != nil || r.TerminalID == "" {
			t.Fatalf("Run = %+v, %v", r, err)
		}
		if _, err := h.m.StopRun(ctx, r.ID); err != nil {
			t.Fatal(err)
		}
		if done := h.wait(r.ID); done.ExitCode != 128+int(syscall.SIGHUP) {
			t.Errorf("exit = %d, want the terminal's SIGHUP", done.ExitCode)
		}
	})
	t.Run("terminal gone", func(t *testing.T) {
		r, err := h.m.Run(ctx, RunOptions{Action: "shell", Worktree: h.web})
		if err != nil {
			t.Fatal(err)
		}
		if err := h.terms.Exit(r.TerminalID, 0); err != nil {
			t.Fatal(err)
		}
		h.wait(r.ID)
		if err := h.terms.Remove(ctx, r.TerminalID); err != nil {
			t.Fatal(err)
		}
		if got, err := h.m.StopRun(ctx, r.ID); err != nil || got.State != RunExited {
			t.Errorf("StopRun = %+v, %v", got, err)
		}
	})
	if _, err := h.m.StopRun(ctx, "r-nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("StopRun(unknown) = %v, want ErrNotFound", err)
	}
}

// An on-worktree-create action that never exits is stopped after HookTimeout, and the
// next one runs.
func TestWorktreeHookTimeout(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.HookTimeout, o.KillGrace = 300*time.Millisecond, 300*time.Millisecond })
	h.create(CreateOptions{ProjectID: "web", Name: "Hang", Command: "sleep 30", OnWorktreeCreate: true})
	h.create(CreateOptions{ProjectID: "web", Name: "Next", Command: "echo next", OnWorktreeCreate: true})
	sub := bus.Subscribe[Event](h.bus, 64)
	defer sub.Close()
	h.m.WorktreeCreated("s1", "web", h.feat)
	var finished []RunFinished
	deadline := time.After(10 * time.Second)
	for len(finished) < 2 {
		select {
		case ev := <-sub.C():
			if e, ok := ev.(RunFinished); ok {
				finished = append(finished, e)
			}
		case <-deadline:
			t.Fatalf("finished = %+v", finished)
		}
	}
	if finished[0].ActionName != "Hang" || finished[0].ExitCode != 128+int(syscall.SIGTERM) ||
		finished[1].ActionName != "Next" || finished[1].ExitCode != 0 {
		t.Errorf("finished = %+v", finished)
	}
}
