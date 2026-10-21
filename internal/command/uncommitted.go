package command

import (
	"errors"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// deleteWorkTitle is the title (and confirm button) of the second-stage confirmation a
// removal asks when it would delete uncommitted work.
const deleteWorkTitle = "Delete Uncommitted Work"

// forceArgs is what the re-invoke of a second-stage confirmation adds: --force.
func forceArgs() map[string]string { return map[string]string{"force": "true"} }

// forceNote ends the description of a command whose --force deletes uncommitted work.
const forceNote = " With uncommitted changes it asks again, naming them, before deleting them; --yes does not answer that " +
	"question (the command fails as without it), --force does."

// uncommittedOf returns the worktrees a backend error names as refused only for their
// uncommitted changes (an UncommittedWork detail), or nil for any other error.
func uncommittedOf(err error) []*v1.Worktree {
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeFailedPrecondition {
		return nil
	}
	for _, d := range ce.Details() {
		if m, derr := d.Value(); derr == nil {
			if u, ok := m.(*v1.UncommittedWork); ok && len(u.GetWorktrees()) > 0 {
				return u.GetWorktrees()
			}
		}
	}
	return nil
}

// changeCounts says what uncommitted work a status has: "2 modified, 1 untracked", or
// "uncommitted changes" when git reported dirty without counts.
func changeCounts(st *v1.GitStatus) string {
	var parts []string
	for _, c := range []struct {
		n    int32
		what string
	}{
		{st.GetStaged(), "staged"},
		{st.GetModified(), "modified"},
		{st.GetUntracked(), "untracked"},
		{st.GetConflicted(), "conflicted"},
	} {
		if c.n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", c.n, c.what))
		}
	}
	if len(parts) == 0 {
		return "uncommitted changes"
	}
	return strings.Join(parts, ", ")
}

// writeWorkLine adds "- cf/a at /path: 2 modified, 1 untracked" on its own line.
func writeWorkLine(b *strings.Builder, w *v1.Worktree) {
	fmt.Fprintf(b, "\n- %s at %s: %s", worktreeLabel(w), w.GetPath(), changeCounts(w.GetStatus()))
}

// deleteWorkConfirm is the second-stage confirmation of command name, refused for the
// uncommitted work in wts: it names each worktree with its counts, says the work is
// deleted, and re-invokes with --force when the user agrees. what is what the command
// removes ("the worktree", "the workspace's worktrees").
func deleteWorkConfirm(name string, wts []*v1.Worktree, what string) *ConfirmError {
	var b strings.Builder
	if len(wts) == 1 {
		w := wts[0]
		fmt.Fprintf(&b, "The worktree of %s at %s has uncommitted work: %s.\n\nRemoving %s deletes that work for good. Delete it?",
			worktreeLabel(w), w.GetPath(), changeCounts(w.GetStatus()), what)
	} else {
		fmt.Fprintf(&b, "%d worktrees have uncommitted work:", len(wts))
		for _, w := range wts {
			writeWorkLine(&b, w)
		}
		fmt.Fprintf(&b, "\n\nRemoving %s deletes that work for good. Delete it?", what)
	}
	return &ConfirmError{Command: name, Title: deleteWorkTitle, Message: b.String(), Args: forceArgs()}
}

// withBranch is what, plus the branches when the command deletes them: the re-run with
// --force deletes them merged or not (git finding 2), so the question says so.
func withBranch(a Args, what string) string {
	if a.Bool("delete-branch") {
		return what + " and its branch (merged or not)"
	}
	return what
}
