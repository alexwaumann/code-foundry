package api

import (
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// The Projects page's "Worktrees without threads" reads managed, landed and the cleanup
// reason off the wire instead of re-deriving git rules.
func TestWorktreeToProtoCleanupFacts(t *testing.T) {
	now := time.Now()
	merged := project.Worktree{
		Path: "/wt/a", Branch: "cf/a", Head: "c2", Managed: true, CreatedAt: now.Add(-time.Hour), CreatedHead: "c1",
		Status: project.Status{BaseRef: "origin/main", RefreshedAt: now},
	}
	with := func(f func(*project.Worktree)) project.Worktree {
		w := merged
		f(&w)
		return w
	}
	tests := []struct {
		name                         string
		w                            project.Worktree
		mergedClean, managed, landed bool
		reason                       string
	}{
		{"merged and clean", merged, true, true, true, "branch is in origin/main"},
		{"made outside the app", with(func(w *project.Worktree) { w.Managed = false }), false, false, true, project.NotManagedReason},
		{"uncommitted, landed otherwise", with(func(w *project.Worktree) { w.Status.Untracked, w.Status.Dirty = 4, true }), false, true, true, project.UncommittedReason},
		{"commits not in the base", with(func(w *project.Worktree) { w.Status.BaseAhead = 3 }), false, true, false, "3 commits not in origin/main"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := worktreeToProto(tt.w)
			if p.GetMergedClean() != tt.mergedClean || p.GetManaged() != tt.managed || p.GetLanded() != tt.landed || p.GetCleanupReason() != tt.reason {
				t.Errorf("got merged_clean=%v managed=%v landed=%v reason=%q, want %v %v %v %q",
					p.GetMergedClean(), p.GetManaged(), p.GetLanded(), p.GetCleanupReason(), tt.mergedClean, tt.managed, tt.landed, tt.reason)
			}
		})
	}
}
