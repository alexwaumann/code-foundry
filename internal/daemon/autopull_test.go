package daemon

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/store/action"
	"github.com/alexwaumann/code-foundry/internal/store/gitops"
	"github.com/alexwaumann/code-foundry/internal/store/gitops/gitopstest"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestCheckoutBusy(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(dir, "other")
	threads := func(ths ...thread.Thread) *thread.Snapshot { return &thread.Snapshot{Threads: ths} }
	runs := func(rs ...action.Run) *action.Snapshot { return &action.Snapshot{Runs: rs} }
	ops := func(xs ...gitops.Op) *gitops.Snapshot { return &gitops.Snapshot{Ops: xs} }
	tests := []struct {
		name    string
		threads *thread.Snapshot
		actions *action.Snapshot
		ops     *gitops.Snapshot
		want    bool
	}{
		{name: "nothing there"},
		{name: "a thread on a turn", threads: threads(thread.Thread{WorktreePath: dir, Status: thread.StatusBusy}), want: true},
		{name: "a thread on a turn, through a symlink", threads: threads(thread.Thread{WorktreePath: link, Status: thread.StatusBusy}), want: true},
		{name: "an idle (connected) thread", threads: threads(thread.Thread{WorktreePath: dir, Status: thread.StatusIdle})},
		{name: "a thread waiting on the user", threads: threads(thread.Thread{WorktreePath: dir, Status: thread.StatusNeedsAttention})},
		{name: "a thread on a turn elsewhere", threads: threads(thread.Thread{WorktreePath: other, Status: thread.StatusBusy})},
		{name: "a running action", actions: runs(action.Run{Worktree: dir, State: action.RunRunning, Mode: action.ModeTerminal}), want: true},
		{name: "an exited action", actions: runs(action.Run{Worktree: dir, State: action.RunExited})},
		{name: "a running action elsewhere", actions: runs(action.Run{Worktree: other, State: action.RunRunning})},
		{name: "a running git op", ops: ops(gitops.Op{WorktreePath: dir, State: gitops.StateRunning}), want: true},
		{name: "a queued git op", ops: ops(gitops.Op{WorktreePath: dir, State: gitops.StateQueued}), want: true},
		{name: "a finished git op", ops: ops(gitops.Op{WorktreePath: dir, State: gitops.StateFailed})},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := checkoutBusy(dir, tt.threads, tt.actions, tt.ops); got != tt.want {
				t.Fatalf("checkoutBusy = %v, want %v", got, tt.want)
			}
		})
	}
}

// TestAutoPullHooksPull: the pull goes through gitops (fast-forward only, an automatic
// title) and a failed op is an error carrying its summary.
func TestAutoPullHooksPull(t *testing.T) {
	ops := gitopstest.New(nil)
	h := autoPullHooks(autoPullSources{
		enabled: func() bool { return true },
		threads: func() *thread.Snapshot { return nil },
		actions: func() *action.Snapshot { return nil },
		ops:     ops,
	})
	w := project.Worktree{Path: "/r", Status: project.Status{Upstream: "origin/main", Behind: 1}}
	if err := h.Pull(context.Background(), w); err != nil {
		t.Fatal(err)
	}
	if len(ops.Calls) != 1 || ops.Calls[0] != "Pull /r rebase=false" {
		t.Fatalf("calls = %v", ops.Calls)
	}
	ops.Fail = "fatal: Not possible to fast-forward, aborting."
	if err := h.Pull(context.Background(), w); err == nil || !strings.Contains(err.Error(), "fast-forward") {
		t.Fatalf("failed op: err = %v", err)
	}
	if h.Busy("/r") {
		t.Fatal("busy with no thread, action or op")
	}
}

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s (in %s): %v\n%s", strings.Join(args, " "), dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

// TestAutoPullEndToEnd runs the real project and gitops stores against a scratch origin
// that gains a commit. Three clones are registered: clean, dirty (a modified file) and
// busy (a thread on a turn). Nothing is pulled while the setting is off; once on, the
// clean clone is fast-forwarded with an "Auto pull origin/main" op in gitops, the dirty
// one is left behind, and the busy one is pulled once its thread's turn ends.
func TestAutoPullEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	cfg := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(cfg, []byte("[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", cfg)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	origin := filepath.Join(base, "origin.git")
	seed := filepath.Join(base, "seed")
	gitIn(t, base, "init", "-q", "--bare", "-b", "main", origin)
	gitIn(t, base, "clone", "-q", origin, seed)
	if err := os.WriteFile(filepath.Join(seed, "README.md"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, seed, "add", ".")
	gitIn(t, seed, "commit", "-q", "-m", "one")
	gitIn(t, seed, "push", "-q", "-u", "origin", "main")
	clean, dirty, busy := filepath.Join(base, "clean"), filepath.Join(base, "dirty"), filepath.Join(base, "busy")
	for _, d := range []string{clean, dirty, busy} {
		gitIn(t, base, "clone", "-q", origin, d)
	}
	if err := os.WriteFile(filepath.Join(dirty, "README.md"), []byte("local edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	d, err := db.Open(context.Background(), dbtest.Path(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	b := bus.New()
	projects, err := project.Start(context.Background(), project.Options{
		DB: d, Bus: b, WorktreeRoot: filepath.Join(base, "worktrees"), AllowedRoot: base,
		FetchInterval: 150 * time.Millisecond, PollInterval: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	ops := gitops.New(gitops.Options{Bus: b, Projects: projects, Root: base})
	t.Cleanup(func() { _ = ops.Close(); _ = projects.Close() })

	var enabled, turn atomic.Bool
	turn.Store(true)
	projects.SetAutoPull(autoPullHooks(autoPullSources{
		enabled: enabled.Load,
		threads: func() *thread.Snapshot {
			st := thread.StatusIdle
			if turn.Load() {
				st = thread.StatusBusy
			}
			return &thread.Snapshot{Threads: []thread.Thread{{ID: "t1", WorktreePath: busy, Status: st}}}
		},
		actions: func() *action.Snapshot { return nil },
		ops:     ops,
	}))
	ids := map[string]string{}
	for _, dir := range []string{clean, dirty, busy} {
		p, err := projects.Register(context.Background(), dir)
		if err != nil {
			t.Fatal(err)
		}
		ids[dir] = p.ID
	}
	projects.SetLiveWorktrees([]string{clean, dirty, busy})

	if err := os.WriteFile(filepath.Join(seed, "two.txt"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, seed, "add", ".")
	gitIn(t, seed, "commit", "-q", "-m", "two")
	gitIn(t, seed, "push", "-q")
	want := gitIn(t, seed, "rev-parse", "HEAD")

	status := func(dir string) project.Worktree {
		w, _ := projects.Snapshot().Worktree(ids[dir], dir)
		return w
	}
	waitFor := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for !cond() {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s", what)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	autoPulls := func(dir string) int {
		n := 0
		for _, o := range ops.Snapshot().Ops {
			if o.Kind == gitops.KindPull && o.WorktreePath == dir {
				if o.Title != "Auto pull origin/main" {
					t.Errorf("pull title = %q", o.Title)
				}
				n++
			}
		}
		return n
	}

	// Off: every clone sees the new commit and stays behind it.
	waitFor("all behind", func() bool {
		return status(clean).Status.Behind == 1 && status(dirty).Status.Behind == 1 && status(busy).Status.Behind == 1
	})
	time.Sleep(500 * time.Millisecond) // a few more fetches
	if n := autoPulls(clean) + autoPulls(dirty) + autoPulls(busy); n != 0 {
		t.Fatalf("%d pulls with the setting off", n)
	}

	enabled.Store(true)
	waitFor("clean fast-forwarded", func() bool {
		w := status(clean)
		return w.Head == want && w.Status.Behind == 0
	})
	if gitIn(t, clean, "rev-parse", "HEAD") != want {
		t.Fatal("clean clone's HEAD did not move")
	}
	if n := autoPulls(clean); n != 1 {
		t.Fatalf("clean clone: %d auto pull ops, want 1", n)
	}
	time.Sleep(500 * time.Millisecond)
	if w := status(dirty); w.Head == want || w.Status.Behind != 1 || autoPulls(dirty) != 0 {
		t.Fatalf("dirty clone was pulled: %+v, ops %d", w, autoPulls(dirty))
	}
	if w := status(busy); w.Head == want || autoPulls(busy) != 0 {
		t.Fatalf("busy clone was pulled while its thread worked: %+v", w)
	}

	turn.Store(false)
	waitFor("busy fast-forwarded after the turn", func() bool { return status(busy).Head == want })
}
