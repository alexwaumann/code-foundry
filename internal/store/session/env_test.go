package session

import "testing"

// Every claude process gets Options.Env: the daemon's loopback endpoint and token,
// so the CLI inside a session reaches the daemon without the Unix socket.
func TestSpawnPassesEnv(t *testing.T) {
	env := []string{"CODE_FOUNDRY_ENDPOINT=http://127.0.0.1:1234", "CODE_FOUNDRY_TOKEN=secret"}
	e := newEnv(t, func(o *Options) { o.Env = append(o.Env, env...) })
	s := e.connected(CreateOptions{})
	if got := e.spec(s.ID).Env; !hasAll(got, env) {
		t.Fatalf("create env = %q, want %q in it", got, env)
	}
	e.exit(s.ID, 0)
	e.waitFor(s.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })
	if _, err := e.m.Reconnect(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if got := e.spec(s.ID).Env; !hasAll(got, env) {
		t.Fatalf("reconnect env = %q, want %q in it", got, env)
	}
}
