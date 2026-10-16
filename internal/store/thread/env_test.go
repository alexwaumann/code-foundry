package thread

import (
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

// Every claude process gets Options.Env: the daemon's loopback endpoint and token,
// so the CLI inside a session reaches the daemon without the Unix socket.
func TestSpawnPassesEnv(t *testing.T) {
	env := []string{"CODE_FOUNDRY_ENDPOINT=http://127.0.0.1:1234", "CODE_FOUNDRY_TOKEN=secret"}
	e := newEnv(t, func(o *Options) { o.Env = append(o.Env, env...) })
	s := e.connected(CreateOptions{})
	// Each thread also gets its own id, the CLI's default --context-session.
	if got := e.spec(s.ID).Env; !hasAll(got, append(slices.Clone(env), paths.EnvThread+"="+s.ID)) {
		t.Fatalf("create env = %q, want %q and its thread in it", got, env)
	}
	e.exit(s.ID, 0)
	e.waitFor(s.ID, "disconnected", func(s Thread) bool { return s.State == StateDisconnected })
	if _, err := e.m.Reconnect(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if got := e.spec(s.ID).Env; !hasAll(got, env) {
		t.Fatalf("reconnect env = %q, want %q in it", got, env)
	}
}

// A new worktree for a thread calls Options.WorktreeCreated once the thread started; a
// thread in an existing worktree does not.
func TestCreateNewWorktreeCallsWorktreeCreated(t *testing.T) {
	type call struct{ thread, repo, worktree string }
	var calls []call
	e, _ := newWorktreeEnv(t, nil, func(o *Options) {
		o.WorktreeCreated = func(threadID, repoID, worktree string) {
			calls = append(calls, call{threadID, repoID, worktree})
		}
	})
	e.namer = func(string) (string, error) { return "Do x", nil }
	s, err := e.m.Create(e.ctx(), CreateOptions{RepoID: "r1", InitialPrompt: "x", NewWorktree: &NewWorktree{}})
	if err != nil {
		t.Fatal(err)
	}
	if want := (call{s.ID, "r1", s.WorktreePath}); len(calls) != 1 || calls[0] != want {
		t.Fatalf("WorktreeCreated calls = %+v, want %+v", calls, want)
	}
	if _, err := e.m.Create(e.ctx(), CreateOptions{RepoID: "r1", WorktreePath: s.WorktreePath}); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 {
		t.Errorf("a thread in an existing worktree called it: %+v", calls)
	}
}
