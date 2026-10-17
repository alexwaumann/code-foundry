package action

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Killing a background run SIGKILLs its whole process group after the grace period,
// also when the shell itself died of the SIGTERM at once (the run finished) and left a
// process that ignores SIGTERM behind.
func TestKillReachesTheGroupAfterTheShellExits(t *testing.T) {
	const grace = 300 * time.Millisecond
	h := newHarness(t, func(o *Options) { o.KillGrace = grace })
	// The child ignores SIGTERM and does not hold the output pipes, so the run finishes
	// as soon as the shell is gone.
	h.create(CreateOptions{ProjectID: "web", Name: "Leaves", Command: "(trap '' TERM; exec sleep 30) >/dev/null 2>&1 & echo $!; wait"})
	r, err := h.m.Run(context.Background(), RunOptions{Action: "leaves", Worktree: h.web})
	if err != nil {
		t.Fatal(err)
	}
	var pid int
	for deadline := time.Now().Add(5 * time.Second); pid == 0; {
		got, err := h.m.GetRun(context.Background(), r.ID)
		if err != nil {
			t.Fatal(err)
		}
		if p, err := strconv.Atoi(strings.TrimSpace(got.Output)); err == nil && p > 0 {
			pid = p
		} else if time.Now().After(deadline) {
			t.Fatalf("no child pid in %q", got.Output)
		} else {
			time.Sleep(20 * time.Millisecond)
		}
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	time.Sleep(200 * time.Millisecond) // let the child's trap be set

	if n := h.m.KillRuns(func(x Run) bool { return x.ID == r.ID }); n != 1 {
		t.Fatalf("KillRuns = %d", n)
	}
	if got := h.wait(r.ID); got.ExitCode != 128+int(syscall.SIGTERM) {
		t.Errorf("exit = %d, want the shell's SIGTERM", got.ExitCode)
	}
	for deadline := time.Now().Add(grace + 3*time.Second); ; {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("child %d ignoring SIGTERM is still alive %s after the kill", pid, grace+3*time.Second)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
