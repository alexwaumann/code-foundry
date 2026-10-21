package terminal

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// A job-control shell runs each job in its own process group: killing the terminal
// hangs up the foreground job too, and SIGKILLs it after the grace period when it
// ignores SIGHUP, even though the shell itself is gone by then.
func TestKillReachesForegroundJob(t *testing.T) {
	tests := []struct {
		name string
		stop func(ctx context.Context, m *Manager, id string) error
	}{
		{"kill and remove", func(ctx context.Context, m *Manager, id string) error { return KillAndRemove(ctx, m, id) }},
		{"kill", func(ctx context.Context, m *Manager, id string) error { return m.Kill(ctx, id) }},
		{"store close", func(ctx context.Context, m *Manager, _ string) error { return m.Close(ctx) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := testCtx(t)
			m := newTestManager(t, Options{KillGrace: 300 * time.Millisecond})
			term, err := m.Create(ctx, Spec{Argv: []string{"/bin/zsh", "-f", "-i"}})
			if err != nil {
				t.Fatal(err)
			}
			ch, err := m.Attach(ctx, term.ID)
			if err != nil {
				t.Fatal(err)
			}
			c := collect(ch)
			if err := m.Write(ctx, term.ID, []byte(`/bin/sh -c 'trap "" HUP; echo "JOB=$$="; exec sleep 600'`+"\n")); err != nil {
				t.Fatal(err)
			}
			re := regexp.MustCompile(`\nJOB=(\d+)=`)
			c.waitFor(t, "the job's pid", func(c *collector) bool { return re.MatchString(c.raw.String()) })
			c.mu.Lock()
			pid, _ := strconv.Atoi(re.FindStringSubmatch(c.raw.String())[1])
			c.mu.Unlock()
			t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
			if err := tt.stop(ctx, m, term.ID); err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(3 * time.Second)
			for !errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
				if time.Now().After(deadline) {
					t.Fatalf("the foreground job %d survived", pid)
				}
				time.Sleep(20 * time.Millisecond)
			}
		})
	}
}
