package session

import (
	"slices"
	"testing"
)

// Every claude process gets Options.Env: the daemon's loopback endpoint and token,
// so the CLI inside a session reaches the daemon without the Unix socket.
func TestSpawnPassesEnv(t *testing.T) {
	env := []string{"CODE_FOUNDRY_ENDPOINT=http://127.0.0.1:1234", "CODE_FOUNDRY_TOKEN=secret"}
	e := newEnv(t, func(o *Options) { o.Env = env })
	s := e.connected(CreateOptions{})
	if spec, _ := e.terms.Spec(s.TerminalID); !slices.Equal(spec.Env, env) {
		t.Fatalf("create env = %q, want %q", spec.Env, env)
	}
	_ = e.terms.Exit(s.TerminalID, 0)
	e.waitFor(s.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })
	r, err := e.m.Reconnect(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if spec, _ := e.terms.Spec(r.TerminalID); !slices.Equal(spec.Env, env) {
		t.Fatalf("reconnect env = %q, want %q", spec.Env, env)
	}
}
