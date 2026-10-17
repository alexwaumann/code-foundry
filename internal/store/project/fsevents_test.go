package project

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/fsnotify/fsevents"
)

// requireFSEvents skips the test when an FSEvents stream cannot be started here.
func requireFSEvents(t *testing.T) {
	t.Helper()
	es := &fsevents.EventStream{Paths: []string{t.TempDir()}, Latency: streamLatency, Flags: streamFlags}
	if err := es.Start(); err != nil {
		t.Skipf("FSEvents unavailable: %v", err)
	}
	es.Stop()
}

// waitStreamPaths waits until the store's stream paths satisfy pred.
func waitStreamPaths(t *testing.T, g *Git, what string, pred func([]string) bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !pred(g.streamPaths()) {
		if time.Now().After(deadline) {
			t.Fatalf("stream paths %v: timed out waiting for %s", g.streamPaths(), what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The stream sees an edit anywhere in a worktree: nested files in the main checkout,
// in a managed worktree, and in a hand-made worktree outside both roots, which the
// stream gains when a reconcile lists it.
func TestStreamSeesNestedEdits(t *testing.T) {
	requireFSEvents(t)
	f := newFixture(t)
	h := startHarness(t, "", Options{WorktreeRoot: filepath.Join(f.base, "wt")})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	managed, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat"})
	if err != nil {
		t.Fatal(err)
	}
	hand := filepath.Join(f.base, "hand")
	git(t, f.project, "worktree", "add", "-q", "-b", "hand", hand)
	h.waitFor("hand-made worktree", func(ev Event) bool {
		u, ok := ev.(ProjectUpdated)
		return ok && len(u.Project.Worktrees) == 3
	})
	waitStreamPaths(t, h.store, "the hand-made worktree", func(p []string) bool { return slices.Contains(p, hand) })
	if got, want := h.store.streamPaths(), []string{filepath.Join(f.base, "hand"), f.project, filepath.Join(f.base, "wt")}; !slices.Equal(got, want) {
		t.Fatalf("stream paths = %v, want %v", got, want)
	}

	for _, wt := range []string{f.project, managed.Path, hand} {
		start := time.Now()
		writeFile(t, filepath.Join(wt, "sub", "x.txt"), "changed in "+wt+"\n")
		h.waitFor("nested edit in "+wt, worktreeUpdated(wt, func(w Worktree) bool { return w.Status.Modified == 1 }))
		t.Logf("nested edit in %s seen after %v", filepath.Base(wt), time.Since(start).Round(time.Millisecond))
		if err := os.MkdirAll(filepath.Join(wt, "sub", "deeper"), 0o755); err != nil {
			t.Fatal(err)
		}
		writeFile(t, filepath.Join(wt, "sub", "deeper", "new.txt"), "n\n")
		h.waitFor("nested new file in "+wt, worktreeUpdated(wt, func(w Worktree) bool { return w.Status.Untracked == 1 }))
	}

	// Removing the hand-made worktree drops it from the stream.
	git(t, f.project, "worktree", "remove", "--force", hand)
	h.waitFor("hand-made worktree removed", func(ev Event) bool {
		rm, ok := ev.(WorktreeRemoved)
		return ok && rm.Path == hand
	})
	waitStreamPaths(t, h.store, "no hand-made worktree", func(p []string) bool { return !slices.Contains(p, hand) })

	// Unregistering drops the project; the managed root stays.
	if err := h.store.Unregister(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	if got := h.store.streamPaths(); !slices.Equal(got, []string{filepath.Join(f.base, "wt")}) {
		t.Fatalf("stream paths after unregister = %v", got)
	}
}

// A burst of thousands of files (an npm install, an untar, a dev server writing
// continuously) costs a bounded number of status runs: FSEvents batches it, and the
// tree debouncer and scheduler coalesce to one run per tree window.
func TestStreamBurstIsBounded(t *testing.T) {
	requireFSEvents(t)
	f := newFixture(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	const window = 200 * time.Millisecond
	h := startHarness(t, "", Options{Runner: cr, TreeDebounce: window})
	r, err := h.store.Register(context.Background(), f.project)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.store.Refresh(context.Background(), r.ID); err != nil {
		t.Fatal(err)
	}
	before := cr.count("status")
	dir := filepath.Join(f.project, "node_modules")
	start := time.Now()
	for i := range 2000 {
		d := filepath.Join(dir, fmt.Sprintf("pkg%02d", i%40))
		if i < 40 {
			if err := os.MkdirAll(d, 0o755); err != nil {
				t.Fatal(err)
			}
		}
		writeFile(t, filepath.Join(d, fmt.Sprintf("f%04d.js", i)), "x\n")
		// Spread the burst over several tree windows, so the cap is what is tested.
		if i%200 == 199 {
			time.Sleep(window / 2)
		}
	}
	burst := time.Since(start)
	// Untracked counts files: every one of the 2000.
	h.waitFor("untracked node_modules", worktreeUpdated(f.project, func(w Worktree) bool { return w.Status.Untracked == 2000 }))
	time.Sleep(time.Second) // let the tail of the burst settle
	runs := cr.count("status") - before
	t.Logf("2000 files in %v: %d status runs", burst.Round(time.Millisecond), runs)
	// One run per tree window while the burst lasts, plus the head and tail.
	if limit := int(burst/window) + 3; runs > limit {
		t.Fatalf("%d status runs for a %v burst (limit %d)", runs, burst, limit)
	}
}

// `git init` in a project without git is seen by the stream, without the poll.
func TestStreamSeesGitInit(t *testing.T) {
	requireFSEvents(t)
	dir := newPlainDir(t)
	h := startHarness(t, "", Options{})
	r, err := h.store.Register(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	waitStreamPaths(t, h.store, "the plain project", func(p []string) bool { return slices.Contains(p, dir) })
	git(t, dir, "init", "-q", "-b", "main")
	h.waitFor("git project", func(ev Event) bool {
		u, ok := ev.(ProjectUpdated)
		return ok && u.Project.ID == r.ID && u.Project.Git
	})
}

func TestResolveMissing(t *testing.T) {
	tmp := t.TempDir() // /var/folders/... on macOS, a symlink to /private/var/...
	real, err := filepath.EvalSymlinks(tmp)
	if err != nil {
		t.Fatal(err)
	}
	if got := resolveMissing(tmp); got != real {
		t.Errorf("resolveMissing(%q) = %q, want %q", tmp, got, real)
	}
	if got, want := resolveMissing(filepath.Join(tmp, "a", "b")), filepath.Join(real, "a", "b"); got != want {
		t.Errorf("resolveMissing(missing) = %q, want %q", got, want)
	}
}
