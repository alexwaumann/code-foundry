package project_test

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// TestCleanupForce: Force relaxes only the uncommitted-changes condition. A worktree
// kept for its changes alone is marked Uncommitted (kept without Force, removed with it);
// one that fails any other condition, or that something holds, is never marked and
// never removed.
func TestCleanupForce(t *testing.T) {
	now := time.Unix(1700000000, 0)
	old := now.Add(-time.Hour)
	merged := project.Worktree{
		ProjectID: "p", Branch: "cf/x", Head: "c2", Managed: true, CreatedAt: old, CreatedHead: "c1",
		Status: project.Status{BaseRef: "origin/main", RefreshedAt: now},
	}
	wt := func(path string, f func(*project.Worktree)) project.Worktree {
		w := merged
		w.Path = path
		f(&w)
		return w
	}
	dirty := func(w *project.Worktree) { w.Status.Dirty, w.Status.Modified, w.Status.Untracked = true, 2, 1 }
	trees := []project.Worktree{
		{ProjectID: "p", Path: "/r", Branch: "main", IsMain: true, Status: project.Status{RefreshedAt: now}},
		wt("/w/clean", func(*project.Worktree) {}),
		wt("/w/dirty", dirty),
		wt("/w/dirty-unmerged", func(w *project.Worktree) { dirty(w); w.Status.BaseAhead = 2 }),
		wt("/w/dirty-unmanaged", func(w *project.Worktree) { dirty(w); w.Managed = false }),
		wt("/w/dirty-fresh", func(w *project.Worktree) { dirty(w); w.CreatedAt, w.Head = now.Add(-time.Minute), "c1" }),
		wt("/w/dirty-held", dirty),
		wt("/w/dirty-rebasing", func(w *project.Worktree) { dirty(w); w.Status.Operation = project.OpRebase }),
	}
	hold := func(w project.Worktree) string {
		if w.Path == "/w/dirty-held" {
			return "thread t1 is on it"
		}
		return ""
	}
	tests := []struct {
		name        string
		force, dry  bool
		removed     []string
		uncommitted []string // marked Uncommitted (removed with force, else kept)
	}{
		{name: "without force the dirty one is kept and marked", removed: []string{"/w/clean"}, uncommitted: []string{"/w/dirty"}},
		{name: "dry run without force", dry: true, removed: []string{"/w/clean"}, uncommitted: []string{"/w/dirty"}},
		{name: "force removes it too", force: true, removed: []string{"/w/clean", "/w/dirty"}, uncommitted: []string{"/w/dirty"}},
		{name: "dry run with force", force: true, dry: true, removed: []string{"/w/clean", "/w/dirty"}, uncommitted: []string{"/w/dirty"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := projecttest.New(nil)
			f.Put(project.Project{ID: "p", Path: "/r", Name: "r", Git: true, Worktrees: trees})
			res, err := project.Cleanup(context.Background(), f, project.CleanupOptions{
				ProjectID: "p", DryRun: tt.dry, Force: tt.force, Hold: hold, Now: func() time.Time { return now },
			})
			if err != nil {
				t.Fatal(err)
			}
			var removed, marked []string
			for _, it := range res.Removed {
				removed = append(removed, it.Worktree.Path)
				if it.Uncommitted {
					marked = append(marked, it.Worktree.Path)
				}
			}
			for _, it := range res.Skipped {
				if it.Uncommitted {
					marked = append(marked, it.Worktree.Path)
				}
				if it.Worktree.Path == "/w/dirty-held" && it.Reason != "thread t1 is on it" {
					t.Errorf("held reason = %q", it.Reason)
				}
			}
			if !slices.Equal(removed, tt.removed) || !slices.Equal(marked, tt.uncommitted) {
				t.Fatalf("removed %v, marked %v; want %v, %v", removed, marked, tt.removed, tt.uncommitted)
			}
			var left []string
			for _, w := range f.Snapshot().Projects[0].Worktrees {
				left = append(left, w.Path)
			}
			for _, p := range tt.removed {
				if slices.Contains(left, p) != tt.dry {
					t.Fatalf("%s still there = %v with dry run %v", p, slices.Contains(left, p), tt.dry)
				}
			}
		})
	}
}

// TestUncommittedError: it is a failed precondition naming the paths.
func TestUncommittedError(t *testing.T) {
	err := error(&project.UncommittedError{Worktrees: []project.Worktree{{Path: "/w/a"}, {Path: "/w/b"}}})
	if !errors.Is(err, project.ErrFailedPrecondition) || err.Error() != "uncommitted changes in /w/a, /w/b; commit them or remove with --force" {
		t.Fatalf("err = %v", err)
	}
}
