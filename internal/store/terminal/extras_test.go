package terminal

import (
	"context"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// The spawn extras (the plugins' environment for bottom-panel shells) join a new
// terminal's environment by its labels: over the defaults, under the spec's own env,
// their PATH entries in front of PATH. A terminal started before keeps its environment.
func TestSpawnExtras(t *testing.T) {
	ctx := testCtx(t)
	m := newTestManager(t, Options{Bus: bus.New()})
	var asked []map[string]string
	m.SetSpawnExtras(func(_ context.Context, labels map[string]string) SpawnExtras {
		asked = append(asked, labels)
		if labels["kind"] != "shell" {
			return SpawnExtras{}
		}
		return SpawnExtras{Env: []string{"CF_HELLO=1", "CF_SPEC=extras"}, PathPrepend: []string{"/plug/bin", "/plug/sbin"}}
	})
	shell := map[string]string{"kind": "shell"}

	env := m.spawnEnv(ctx, Spec{Labels: shell, Env: []string{"CF_SPEC=spec", "PATH=/usr/bin:/bin"}})
	for key, want := range map[string]string{"CF_HELLO": "1", "CF_SPEC": "spec", "PATH": "/plug/bin:/plug/sbin:/usr/bin:/bin", "TERM": "xterm-256color"} {
		if got := envValue(env, key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	if env := m.spawnEnv(ctx, Spec{Labels: map[string]string{"kind": "action"}}); envValue(env, "CF_HELLO") != "" {
		t.Error("an action run got the shell extras")
	}
	if len(asked) != 2 || asked[0]["kind"] != "shell" {
		t.Errorf("asked with %v", asked)
	}

	// End to end: the shell sees it.
	term, err := m.Create(ctx, Spec{Argv: []string{"/bin/sh", "-c", `printf '%s|%s\r\n' "$CF_HELLO" "${PATH%%:*}"; sleep 0.2`}, Labels: shell, Cols: 60, Rows: 5})
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
	text := screenText(t, c.raw.Bytes(), 60, 5)
	c.mu.Unlock()
	if !strings.Contains(text, "1|/plug/bin") {
		t.Errorf("shell printed %q, want 1|/plug/bin", text)
	}

	// Removed: new terminals get nothing.
	m.SetSpawnExtras(nil)
	if env := m.spawnEnv(ctx, Spec{Labels: shell}); envValue(env, "CF_HELLO") != "" {
		t.Error("extras after SetSpawnExtras(nil)")
	}
}
