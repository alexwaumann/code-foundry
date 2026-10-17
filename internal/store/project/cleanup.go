package project

import (
	"context"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

// MergedCleanReason is the git half of the worktree cleanup rule: "" when w can be
// removed without losing work, else why not. Removable means not the main worktree,
// created by Code Foundry (Managed: under its worktrees directory), on a branch, a status that has been read without error, no staged, modified,
// untracked or conflicted entries, and every commit on HEAD in the remote-tracking
// default branch (Status.BaseRef set, BaseAhead 0). Pure.
//
// Live threads, running terminals and workspace membership are the other half; the
// project store does not know them (CleanupOptions.Hold).
func MergedCleanReason(w Worktree) string {
	st := w.Status
	switch {
	case w.IsMain:
		return "main worktree"
	case !w.Managed:
		return NotManagedReason
	case w.Detached || w.Branch == "":
		return "detached HEAD"
	case st.Error != "":
		return "git status failed: " + st.Error
	case st.RefreshedAt.IsZero():
		return "git status not read yet"
	case st.Operation != "":
		return st.Operation + " in progress"
	case st.Dirty || st.Staged+st.Modified+st.Untracked+st.Conflicted > 0:
		return "uncommitted changes"
	case st.BaseRef == "":
		return "no remote default branch to compare with"
	case st.BaseAhead > 0:
		n := "commits"
		if st.BaseAhead == 1 {
			n = "commit"
		}
		return strconv.Itoa(st.BaseAhead) + " " + n + " not in " + st.BaseRef
	}
	return ""
}

// NotManagedReason is why a worktree outside the app's worktrees directory is kept.
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

// MergedClean reports MergedCleanReason(w) == "".
func (w Worktree) MergedClean() bool { return MergedCleanReason(w) == "" }

// CleanupOptions configures Cleanup.
type CleanupOptions struct {
	ProjectID string
	// Path is the one worktree to clean up; "" means every worktree of the project.
	Path string
	// DryRun evaluates the current snapshot only: no refresh, nothing removed, and
	// Removed lists what would be.
	DryRun bool
	// Hold returns why something outside git keeps w (a live thread runs in it, a
	// terminal is open there, a workspace has it), or "". It is asked right before each
	// removal. Nil: nothing holds a worktree.
	Hold func(w Worktree) string
}

// CleanupSkip is a worktree Cleanup kept, and why.
type CleanupSkip struct {
	Worktree Worktree
	Reason   string
}

// CleanupResult is what Cleanup did.
type CleanupResult struct {
	ProjectID string
	Removed   []Worktree
	Skipped   []CleanupSkip
}

// Cleanup removes the worktrees of a project whose work is already in its default branch
// (MergedCleanReason "" and no Hold): it refreshes the project's status (reconcile, base,
// every worktree; callers that want fresh remote refs fetch first), re-evaluates each
// worktree, and removes it with RemoveWorktree, never forced, so git itself still
// refuses a worktree that changed meanwhile. Branches are never deleted. A failed
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
	res := CleanupResult{ProjectID: r.ID}
	for _, w := range candidates {
		if opts.Path == "" && w.IsMain {
			continue
		}
		reason := MergedCleanReason(w)
		if reason == "" && opts.Hold != nil {
			reason = opts.Hold(w)
		}
		if reason != "" {
			res.Skipped = append(res.Skipped, CleanupSkip{Worktree: w, Reason: reason})
			continue
		}
		if !opts.DryRun {
			if err := s.RemoveWorktree(ctx, RemoveWorktreeOptions{ProjectID: r.ID, Path: w.Path}); err != nil {
				if ctx.Err() != nil {
					return res, ctx.Err()
				}
				res.Skipped = append(res.Skipped, CleanupSkip{Worktree: w, Reason: err.Error()})
				continue
			}
		}
		res.Removed = append(res.Removed, w)
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
