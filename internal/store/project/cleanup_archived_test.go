package project

import (
	"testing"
	"time"
)

// An archived thread's worktree goes when the app made it and it is clean; commits not
// in the base and a fresh worktree are no reason to keep it.
func TestArchivedVerdict(t *testing.T) {
	now := time.Now()
	clean := Worktree{Managed: true, Branch: "feat/x", Status: Status{RefreshedAt: now}}
	with := func(f func(*Worktree)) Worktree {
		w := clean
		f(&w)
		return w
	}
	tests := []struct {
		name   string
		w      Worktree
		want   bool
		reason string
	}{
		{"clean", clean, true, ArchivedReason},
		{"unpushed commits", with(func(w *Worktree) { w.Status.BaseAhead, w.Status.BaseRef = 3, "origin/main" }), true, ArchivedReason},
		{"just made", with(func(w *Worktree) { w.CreatedAt, w.CreatedHead, w.Head = now, "a", "a" }), true, ArchivedReason},
		{"no remote default branch", with(func(w *Worktree) { w.Status.BaseRef = "" }), true, ArchivedReason},
		{"main worktree", with(func(w *Worktree) { w.IsMain = true }), false, "main worktree"},
		{"not ours", with(func(w *Worktree) { w.Managed = false }), false, NotManagedReason},
		{"detached", with(func(w *Worktree) { w.Detached, w.Branch = true, "" }), false, "detached HEAD"},
		{"status failed", with(func(w *Worktree) { w.Status.Error = "boom" }), false, "git status failed: boom"},
		{"status not read", with(func(w *Worktree) { w.Status.RefreshedAt = time.Time{} }), false, "git status not read yet"},
		{"rebase in progress", with(func(w *Worktree) { w.Status.Operation = "rebase" }), false, "rebase in progress"},
		{"rebase in progress, HEAD detached by it", with(func(w *Worktree) {
			w.Status.Operation, w.Detached, w.Branch = "rebase", true, ""
		}), false, "rebase in progress"},
		{"untracked file", with(func(w *Worktree) { w.Status.Untracked = 1 }), false, UncommittedReason},
		{"staged", with(func(w *Worktree) { w.Status.Staged = 1 }), false, UncommittedReason},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, reason := ArchivedVerdict(tt.w, now)
			if got != tt.want || reason != tt.reason {
				t.Errorf("ArchivedVerdict = %v %q, want %v %q", got, reason, tt.want, tt.reason)
			}
		})
	}
}
