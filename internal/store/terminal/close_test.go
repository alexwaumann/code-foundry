package terminal

import (
	"errors"
	"testing"
	"time"
)

func TestKillAndRemoveRealProcess(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{KillGrace: 200 * time.Millisecond})
	tests := []struct {
		name   string
		script string
	}{
		{"honours SIGHUP", `while :; do sleep 0.05; done`},
		{"ignores SIGHUP", `trap '' HUP; while :; do sleep 0.05; done`},
		{"already exited", `exit 3`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", tt.script}})
			if err != nil {
				t.Fatal(err)
			}
			if err := KillAndRemove(ctx, m, term.ID); err != nil {
				t.Fatalf("KillAndRemove: %v", err)
			}
			if _, err := m.Get(ctx, term.ID); !errors.Is(err, ErrNotFound) {
				t.Errorf("Get after KillAndRemove = %v, want ErrNotFound", err)
			}
		})
	}
	if err := KillAndRemove(ctx, m, "t-nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("KillAndRemove(unknown) = %v, want ErrNotFound", err)
	}
}
