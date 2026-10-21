package project

import (
	"context"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// FreshFor is how long cleanup keeps a worktree the app made while its HEAD is still the
// commit it was made at: a thread or an orchestrator that just made it has not
// committed yet, and an empty branch is otherwise "in the base". It does not apply to
// an abandoned worktree (CleanupOptions.Abandoned): no one is about to commit there.
const FreshFor = 10 * time.Minute

// CleanupVerdict is the git half of the worktree cleanup rule for w at now: whether it
// can be removed without losing work, and why (or why not). Pure.
//
// Removable means: not the main worktree; made by Code Foundry (Managed: recorded when
// it was made, not merely under the worktrees directory); on a branch; a status read
// without error; no operation in progress; no staged, modified, untracked or conflicted
// entries; a remote-tracking default branch to compare with (Status.BaseRef); not made
// in the last FreshFor with no commit since; and its work is in BaseRef, either because
// HEAD is reachable from it (BaseAhead 0) or because its changes landed as a rebased or
// squash-merged copy (Status.BaseMerged).
//
// Live threads, running terminals and workspace membership are the other half; the
// project store does not know them (CleanupOptions.Hold).
func CleanupVerdict(w Worktree, now time.Time) (removable bool, reason string) {
	return cleanupVerdict(w, now, false)
}

// AbandonedReason is the reason an abandoned worktree (CleanupOptions.Abandoned) with
// no commits since it was made goes.
const AbandonedReason = "no commits since it was made; its threads are archived or removed"

// cleanupVerdict is CleanupVerdict; abandoned lifts the FreshFor rule (a worktree whose
// threads are all archived or removed: none of them will commit).
func cleanupVerdict(w Worktree, now time.Time, abandoned bool) (removable bool, reason string) {
	st := w.Status
	switch {
	case w.IsMain:
		return false, "main worktree"
	case !w.Managed:
		return false, NotManagedReason
	case w.Detached || w.Branch == "":
		return false, "detached HEAD"
	case st.Error != "":
		return false, "git status failed: " + st.Error
	case st.RefreshedAt.IsZero():
		return false, "git status not read yet"
	case st.Operation != "":
		return false, st.Operation + " in progress"
	case st.HasUncommitted():
		return false, UncommittedReason
	case st.BaseRef == "":
		return false, "no remote default branch to compare with"
	case justMade(w, now) && !abandoned:
		return false, "no commits yet, made less than " + strconv.Itoa(int(FreshFor/time.Minute)) + " minutes ago"
	case justMade(w, now) && st.BaseAhead == 0:
		return true, AbandonedReason
	case st.BaseAhead > 0 && st.BaseMerged:
		return true, "a rebased or squash-merged copy is in " + st.BaseRef
	case st.BaseAhead > 0:
		n := "commits"
		if st.BaseAhead == 1 {
			n = "commit"
		}
		return false, strconv.Itoa(st.BaseAhead) + " " + n + " not in " + st.BaseRef
	case w.CreatedHead != "" && w.Head == w.CreatedHead:
		return true, "no commits since it was made"
	}
	return true, "branch is in " + st.BaseRef
}

// justMade: w was made less than FreshFor before now and HEAD has not moved since (or
// the head it was made at is unknown).
func justMade(w Worktree, now time.Time) bool {
	return !w.CreatedAt.IsZero() && now.Sub(w.CreatedAt) < FreshFor &&
		(w.CreatedHead == "" || w.Head == w.CreatedHead)
}

// UncommittedReason is why a worktree with staged, modified, untracked or conflicted
// entries is kept.
const UncommittedReason = "uncommitted changes"

// NotManagedReason is why a worktree the app did not make is kept.
const NotManagedReason = "not a Code Foundry worktree"

// InsideRoot reports whether path is strictly inside one of roots (never a root
// itself). Paths compare cleaned; a root is also tried with symlinks resolved, since
// snapshot paths are resolved (/tmp is /private/tmp). A path that only shares a prefix
// string ("/x/worktrees2" for "/x/worktrees") is not inside. Empty roots are skipped,
// so no roots means nothing is inside. Pure apart from resolving the roots.
func InsideRoot(path string, roots ...string) bool {
	if path == "" {
		return false
	}
	path = filepath.Clean(path)
	for _, root := range roots {
		if root == "" {
			continue
		}
		root = filepath.Clean(root)
		for _, r := range []string{root, resolved(root)} {
			rel, err := filepath.Rel(r, path)
			if err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return true
			}
		}
	}
	return false
}

// resolved is p with symlinks resolved, or p when that fails (it does not exist yet).
func resolved(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return p
}

// MergedClean reports whether CleanupVerdict(w, now) is removable.
func (w Worktree) MergedClean(now time.Time) bool {
	ok, _ := CleanupVerdict(w, now)
	return ok
}

// CleanupOptions configures Cleanup.
type CleanupOptions struct {
	ProjectID string
	// Path is the one worktree to clean up; "" means every worktree of the project.
	Path string
	// DryRun evaluates the current snapshot only: no refresh, nothing removed, and
	// Removed lists what would be.
	DryRun bool
	// Force also removes the worktrees kept only for their uncommitted changes (every
	// other CleanupVerdict condition passes and Hold has nothing), with `git worktree
	// remove --force`, deleting those changes. It relaxes no other condition.
	Force bool
	// Hold returns why something outside git keeps w (a live thread runs in it, a
	// terminal is open there, a workspace has it), or "". It is asked right before each
	// removal. Nil: nothing holds a worktree.
	Hold func(w Worktree) string
	// Abandoned reports whether every thread that worked in w is archived or removed
	// (and there was one): the FreshFor rule then does not keep it. Nil: none is.
	Abandoned func(w Worktree) bool
	// Now is the time CleanupVerdict judges at. Nil: time.Now.
	Now func() time.Time
}

// CleanupItem is a worktree Cleanup removed (or would), or kept, and why.
type CleanupItem struct {
	Worktree Worktree
	Reason   string
	// Uncommitted: kept only for its uncommitted changes (Force removes it), or, when
	// removed, removed with Force and its uncommitted changes with it.
	Uncommitted bool
}

// CleanupResult is what Cleanup did.
type CleanupResult struct {
	ProjectID string
	Removed   []CleanupItem
	Skipped   []CleanupItem
}

// Cleanup removes the worktrees of a project whose work is already in its default branch
// (CleanupVerdict removable and no Hold): it refreshes the project's status (reconcile, base,
// every worktree; callers that want fresh remote refs fetch first), re-evaluates each
// worktree, and removes it with RemoveWorktree, not forced unless opts.Force and only
// for a worktree kept for its uncommitted changes alone, so git itself still refuses a
// clean worktree that changed meanwhile. Branches are never deleted. A failed
// removal is a skip with git's error as the reason, not an error. Without a Path the
// main worktree is left out of Skipped.
func Cleanup(ctx context.Context, s Store, opts CleanupOptions) (CleanupResult, error) {
	r, ok := s.Snapshot().Project(opts.ProjectID)
	if !ok {
		return CleanupResult{}, fmt.Errorf("%w: project %q", ErrNotFound, opts.ProjectID)
	}
	if !r.Git {
		return CleanupResult{}, fmt.Errorf("%w: %w", ErrFailedPrecondition, ErrNotGit)
	}
	if !opts.DryRun {
		if err := s.Refresh(ctx, r.ID); err != nil {
			return CleanupResult{}, fmt.Errorf("refresh %s: %w", r.Name, err)
		}
		if r, ok = s.Snapshot().Project(r.ID); !ok {
			return CleanupResult{}, fmt.Errorf("%w: project %q", ErrNotFound, opts.ProjectID)
		}
	}
	candidates := r.Worktrees
	if opts.Path != "" {
		w, ok := findWorktree(r, opts.Path)
		if !ok {
			return CleanupResult{}, fmt.Errorf("%w: worktree %q in project %s", ErrNotFound, opts.Path, r.Name)
		}
		candidates = []Worktree{w}
	}
	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}
	res := CleanupResult{ProjectID: r.ID}
	for _, w := range candidates {
		if opts.Path == "" && w.IsMain {
			continue
		}
		abandoned := opts.Abandoned != nil && opts.Abandoned(w)
		removable, reason := cleanupVerdict(w, now(), abandoned)
		// Kept for its uncommitted changes alone: with them set aside every other
		// condition passes.
		uncommitted := false
		if !removable && w.Status.HasUncommitted() {
			if ok, why := cleanupVerdict(withoutUncommitted(w), now(), abandoned); ok {
				uncommitted = true
				if opts.Force {
					removable, reason = true, why
				}
			}
		}
		if (removable || uncommitted) && opts.Hold != nil {
			if held := opts.Hold(w); held != "" {
				removable, reason, uncommitted = false, held, false
			}
		}
		item := CleanupItem{Worktree: w, Reason: reason, Uncommitted: uncommitted}
		if !removable {
			res.Skipped = append(res.Skipped, item)
			continue
		}
		if !opts.DryRun {
			if err := s.RemoveWorktree(ctx, RemoveWorktreeOptions{ProjectID: r.ID, Path: w.Path, Force: uncommitted}); err != nil {
				if ctx.Err() != nil {
					return res, ctx.Err()
				}
				res.Skipped = append(res.Skipped, CleanupItem{Worktree: w, Reason: err.Error()})
				continue
			}
		}
		res.Removed = append(res.Removed, item)
	}
	return res, nil
}

// findWorktree finds path among r's worktrees, as given or with symlinks resolved.
func findWorktree(r Project, path string) (Worktree, bool) {
	clean := filepath.Clean(path)
	real := clean
	if p, err := filepath.EvalSymlinks(clean); err == nil {
		real = p
	}
	for _, w := range r.Worktrees {
		if w.Path == clean || w.Path == real {
			return w, true
		}
	}
	return Worktree{}, false
}
