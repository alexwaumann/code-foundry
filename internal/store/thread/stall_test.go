package thread

import (
	"errors"
	"strings"
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
			if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "Claude did not answer the "+tt.what+" within 300ms") {
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
