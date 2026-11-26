package project

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsevents"
)

// A rescan (FSEvents dropped or coalesced events) must refresh the status of the
// worktrees whose events may be lost, not only reconcile: since the base fan-out runs
// only when origin/<default> moves, a reconcile alone refreshes no status, and edits
// and HEAD moves made during a build stayed stale until the next poll.
func TestRescanRefreshesStatus(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	side, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "side"})
	if err != nil {
		t.Fatal(err)
	}
	h.settle()
	modified := func(path string) int {
		w, _ := h.store.Snapshot().Worktree(r.ID, path)
		return w.Status.Modified
	}

	// Dropped events inside one worktree's tree: that worktree is refreshed.
	writeFile(t, filepath.Join(side.Path, "README.md"), "edited during a build\n")
	h.store.onEvents([]fsevents.Event{{Path: side.Path, Flags: fsevents.MustScanSubDirs | fsevents.UserDropped}})
	eventually(t, "the side worktree's edit after a rescan", 5*time.Second, func() bool { return modified(side.Path) == 1 })

	// Dropped events at a root covering the project: every worktree is refreshed.
	writeFile(t, filepath.Join(f.project, "README.md"), "edited too\n")
	writeFile(t, filepath.Join(side.Path, "sub", "x.txt"), "and this\n")
	h.store.onEvents([]fsevents.Event{{Path: f.base, Flags: fsevents.MustScanSubDirs | fsevents.KernelDropped}})
	eventually(t, "both worktrees' edits after a rescan", 5*time.Second, func() bool {
		return modified(f.project) == 1 && modified(side.Path) == 2
	})
}

// A config rewrite (here `git branch -u`) can change any worktree's upstream: it
// refreshes the statuses as well as reconciling.
func TestConfigRewriteRefreshesUpstream(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	side, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "side"})
	if err != nil {
		t.Fatal(err)
	}
	if side.Status.Upstream != "" {
		t.Fatalf("side starts with upstream %q", side.Status.Upstream)
	}
	h.fsChanged() // the fixture's own changes are the baseline
	h.settle()
	git(t, side.Path, "branch", "-q", "-u", "origin/main")
	h.fsChanged()
	eventually(t, "the new upstream after a config rewrite", 5*time.Second, func() bool {
		w, _ := h.store.Snapshot().Worktree(r.ID, side.Path)
		return w.Status.Upstream == "origin/main"
	})
}

// settle waits until no debounce timer is armed and the scheduler has nothing queued
// or running, so what a test does next is not absorbed into earlier work.
func (h *harness) settle() {
	h.t.Helper()
	g := h.store
	idle := func() bool {
		for _, d := range []*debouncer{g.deb, g.treeDeb, g.touch} {
			d.mu.Lock()
			n := len(d.timers)
			d.mu.Unlock()
			if n > 0 {
				return false
			}
		}
		g.sched.mu.Lock()
		defer g.sched.mu.Unlock()
		for _, st := range g.sched.jobs {
			if st.queued || st.running || st.rerun {
				return false
			}
		}
		return true
	}
	deadline := time.Now().Add(20 * time.Second)
	for stable := 0; stable < 3; {
		if time.Now().After(deadline) {
			h.t.Fatal("the store did not settle")
		}
		if idle() {
			stable++
		} else {
			stable = 0
		}
		time.Sleep(5 * time.Millisecond)
	}
}
