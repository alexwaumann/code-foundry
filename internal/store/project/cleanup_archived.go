package project

import "time"

// ArchivedVerdict is the git half of the cleanup a thread's archive runs on each of its
// worktree-mode checkouts (docs/notes/workspaces-v2-1-threads.md,
// docs/notes/thread-checkouts.md): CleanupVerdict without the
// base rule. A worktree the app made, on a branch, whose status reads clean (no staged,
// modified, untracked or conflicted entries) with no operation in progress, goes at
// once: its commits live on its branch, which is never deleted, so a pushed or unpushed
// commit is no reason to keep it, and the thread that was on it is archived, so nobody
// is about to commit there (no FreshFor). Whether another thread or a terminal still
// has it is the Hold half. Pure; now is unused and there to match CleanupOptions.Verdict.
func ArchivedVerdict(w Worktree, _ time.Time) (removable bool, reason string) {
	st := w.Status
	switch {
	case w.IsMain:
		return false, "main worktree"
	case !w.Managed:
		return false, NotManagedReason
	case st.Operation != "":
		// Before the detached check: a rebase detaches HEAD, and it is the reason.
		return false, st.Operation + " in progress"
	case w.Detached || w.Branch == "":
		return false, "detached HEAD"
	case st.Error != "":
		return false, "git status failed: " + st.Error
	case st.RefreshedAt.IsZero():
		return false, "git status not read yet"
	case st.HasUncommitted():
		return false, UncommittedReason
	}
	return true, ArchivedReason
}

// ArchivedReason is why ArchivedVerdict removes a worktree.
const ArchivedReason = "clean, and the thread on it is archived (its branch stays)"
