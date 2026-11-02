package project

import (
	"strings"
)

// HasUncommitted reports whether st has staged, modified, untracked or conflicted
// entries: what `git worktree remove` refuses without --force.
func (st Status) HasUncommitted() bool {
	return st.Dirty || st.Staged+st.Modified+st.Untracked+st.Conflicted > 0
}

// UncommittedError is a worktree removal refused only because the worktrees have
// uncommitted changes (Worktree.Status has the counts). It wraps ErrFailedPrecondition;
// the same removal with force deletes those changes.
type UncommittedError struct {
	Worktrees []Worktree
}

func (e *UncommittedError) Error() string {
	paths := make([]string, len(e.Worktrees))
	for i, w := range e.Worktrees {
		paths[i] = w.Path
	}
	return "uncommitted changes in " + strings.Join(paths, ", ") + "; commit them or remove with --force"
}

// Unwrap makes errors.Is(err, ErrFailedPrecondition) true.
func (e *UncommittedError) Unwrap() error { return ErrFailedPrecondition }
