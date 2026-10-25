package thread

import (
	"cmp"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// Recreating a cleaned-up worktree (docs/notes/recreate-worktree.md). A cleanup
// (project.worktree.cleanup) removes merged worktrees the app made and keeps their
// branches. A thread whose worktree went that way is made whole again when something
// starts its Claude (a message, Reconnect, running): the worktree is made again on the
// branch the thread was created for (Thread.Branch), at the same path, so Claude's
// transcript (keyed by the path) is found and --resume keeps its memory. Viewing a thread
// never recreates anything.
//
// It applies when the cwd is missing, lies under the app's worktrees directory
// (Options.WorktreeRoot) and the row has a branch. Anything else keeps the refusal
// resumeLaunch gives a missing worktree. The thread's other members' worktrees are made
// again the same way (ensureMembers, placement.go).

// fetchBranchTimeout bounds the fetch that looks for a branch on origin.
const fetchBranchTimeout = 30 * time.Second

// recreatedWorktree is what recreateWorktree made, for the timeline note and the
// worktree-created hook.
type recreatedWorktree struct {
	projectID, path, branch string
	// base is the ref the branch was made again from, when it was gone locally and on
	// origin; empty when the worktree checked out the existing branch.
	base string
}

// note is the timeline line for a recreated worktree.
func (rw recreatedWorktree) note() string {
	if rw.base == "" {
		return "The worktree was removed and has been recreated from branch " + rw.branch +
			". Untracked and ignored files from before (build output, installed dependencies, local config) are gone."
	}
	return "The worktree was removed and branch " + rw.branch + " no longer existed, so both were recreated from " + rw.base +
		". Commits made on the branch earlier are on it only if they reached " + rw.base +
		" (a merged branch's have), and untracked and ignored files from before are gone."
}

// recreatable reports whether s's missing cwd may be made again (see above). A
// workspace reference no longer stops it: the members' worktrees are derived from the
// thread's branch (checkouts.go), and ensureMembers makes the others' again.
func (m *Manager) recreatable(s Thread) bool {
	return s.Branch != "" && s.ProjectID != "" && m.opts.Projects != nil &&
		project.InsideRoot(s.WorktreePath, m.opts.WorktreeRoot)
}

// remadeNote is the timeline line for member worktrees ensureMembers made again on
// branch. One whose branch was gone too (newBranch) says so, as the primary's note does.
func remadeNote(made []madeWorktree, branch string) string {
	var paths, lines []string
	for _, w := range made {
		if !w.newBranch {
			paths = append(paths, w.path)
			continue
		}
		start := cmp.Or(w.startPoint, "the default branch")
		lines = append(lines, "The worktree of project "+cmp.Or(w.projectName, w.projectID)+" ("+w.path+") was removed and branch "+branch+
			" no longer existed there, so both were recreated from "+start+". Commits made on the branch there earlier are on it only if they reached "+
			start+" (a merged branch's have), and untracked and ignored files from before are gone.")
	}
	if len(paths) > 0 {
		what := "The worktree of another project of this thread was removed and has been recreated"
		if len(paths) > 1 {
			what = "The worktrees of other projects of this thread were removed and have been recreated"
		}
		lines = append([]string{what + " from branch " + branch + " (" + strings.Join(paths, ", ") + "). Untracked and ignored files from before are gone."}, lines...)
	}
	return strings.Join(lines, " ")
}

// ensureWorktree makes s's worktree again when it is missing and recreatable, and
// returns what it made; nil (and no error) when the cwd exists or is not recreatable, in
// which case resumeLaunch decides as before. For a reserved start (startStopped):
// synchronous, and it may fetch, which can take seconds, so it first publishes the
// thread as it is now (STARTING, and busy for a message), which startStopped otherwise
// publishes only once the launch is decided.
func (m *Manager) ensureWorktree(ctx context.Context, s Thread) (*recreatedWorktree, error) {
	if _, err := os.Stat(s.WorktreePath); err == nil || !os.IsNotExist(err) || !m.recreatable(s) {
		return nil, nil
	}
	m.update(s.ID, false, func(*record) {})
	m.log.Info("worktree of thread is gone; recreating it", "thread", s.ID, "path", s.WorktreePath, "branch", s.Branch)
	rw, err := m.recreateWorktree(ctx, s)
	if err != nil {
		return nil, err
	}
	m.log.Info("worktree recreated for thread", "thread", s.ID, "path", rw.path, "branch", rw.branch, "base", rw.base)
	return &rw, nil
}

// recreateWorktree makes s's worktree on s.Branch through the project store: the local
// branch when it exists, else origin's (fetched first when no remote-tracking ref has
// it), else a new branch from s.BaseRef (origin/<default branch> when the row has none).
// The result must be at s.WorktreePath: the project store picks the path from the project
// and branch, and resuming in another directory would lose Claude's transcript.
func (m *Manager) recreateWorktree(ctx context.Context, s Thread) (recreatedWorktree, error) {
	gone := func(why string) error {
		return fmt.Errorf("%w: worktree %s is gone and cannot be recreated: %s", ErrFailedPrecondition, s.WorktreePath, why)
	}
	r, ok := m.opts.Projects.Snapshot().Project(s.ProjectID)
	if !ok {
		return recreatedWorktree{}, gone("its project " + s.ProjectID + " is no longer registered")
	}
	if !r.Git {
		return recreatedWorktree{}, gone(r.Name + " is not a git repository")
	}
	if err := mainCheckoutBusy(r, s.Branch); err != nil {
		return recreatedWorktree{}, err // never a second worktree on that branch
	}
	rw := recreatedWorktree{projectID: r.ID, branch: s.Branch}
	opts := project.CreateWorktreeOptions{ProjectID: r.ID, Branch: s.Branch, Fetch: true, BaseFromOrigin: m.opts.BaseFromOrigin()}
	local := m.opts.RefExists(ctx, r.Path, "refs/heads/"+s.Branch)
	remote := !local && (m.opts.RefExists(ctx, r.Path, "refs/remotes/origin/"+s.Branch) || m.opts.FetchBranch(ctx, r.Path, s.Branch))
	if !local && !remote {
		// No BaseRef: the project store's default base (origin/<default>, fetched, or
		// the local default with projects.base_from_origin off).
		opts.BaseRef = s.BaseRef
	}
	wt, err := m.opts.Projects.CreateWorktree(ctx, opts)
	if err != nil {
		return recreatedWorktree{}, projectError("recreate worktree "+s.Branch, err)
	}
	if !local && !remote {
		rw.base = cmp.Or(wt.StartPoint, s.BaseRef, wt.Status.BaseRef, "origin/"+cmp.Or(r.DefaultBranch, "main"))
	}
	if !samePath(wt.Path, s.WorktreePath) {
		return recreatedWorktree{}, fmt.Errorf("%w: recreated the worktree of branch %s at %s, not at the thread's %s; "+
			"not resuming in another directory (Claude's conversation is kept by path)", ErrFailedPrecondition, s.Branch, wt.Path, s.WorktreePath)
	}
	rw.path = s.WorktreePath
	return rw, nil
}

// gitFetchBranch is the default Options.FetchBranch: it fetches origin's branch into
// its remote-tracking ref and reports whether origin has it. No origin, an offline
// machine and a branch origin does not have all report false.
func gitFetchBranch(ctx context.Context, dir, branch string) bool {
	ctx, cancel := context.WithTimeout(ctx, fetchBranchTimeout)
	defer cancel()
	refspec := "+refs/heads/" + branch + ":refs/remotes/origin/" + branch
	return exec.CommandContext(ctx, "git", "-C", dir, "fetch", "--quiet", "--no-tags", "origin", refspec).Run() == nil
}

// Rows from before the branch column (migration 0027) have none. backfillBranches
// reads it from the project store while their worktree still exists: once a row's
// project has listed its worktrees (its first reconcile after a daemon start), the
// worktree at the row's path gives the branch, or the row is left without one (the
// worktree is gone, or detached).

// backfillLimit is how long backfillBranches waits for projects to list their worktrees.
const backfillLimit = 2 * time.Minute

// backfillPending are the threads whose branch can still be read: the app made their
// worktree and the row has no branch.
func (m *Manager) backfillPending() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var ids []string
	for id, rec := range m.recs {
		if rec.s.CreatedWorktree && rec.s.Branch == "" && rec.s.ProjectID != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

// startBackfill runs backfillBranches in the background when some row needs it.
func (m *Manager) startBackfill() {
	pending := m.backfillPending()
	if len(pending) == 0 || m.opts.Projects == nil {
		return
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.backfillBranches(pending, m.opts.Tick, backfillLimit)
	}()
}

// backfillBranches checks pending against the project snapshot every tick until each
// is decided, Shutdown, or limit passed.
func (m *Manager) backfillBranches(pending []string, tick, limit time.Duration) {
	t := time.NewTicker(tick)
	defer t.Stop()
	deadline := time.Now().Add(limit)
	for {
		pending = m.backfillStep(pending)
		if len(pending) == 0 {
			return
		}
		if time.Now().After(deadline) {
			m.log.Info("branches of threads not filled in: their projects did not list worktrees", "threads", len(pending))
			return
		}
		select {
		case <-m.ctx.Done():
			return
		case <-t.C:
		}
	}
}

// backfillStep decides what it can of pending against the current project snapshot
// and returns the threads still undecided (their project has not listed worktrees yet).
func (m *Manager) backfillStep(pending []string) []string {
	snap := m.opts.Projects.Snapshot()
	if snap == nil {
		return pending
	}
	var left []string
	for _, id := range pending {
		s, ok := m.Snapshot().Thread(id)
		if !ok || s.Branch != "" {
			continue
		}
		branch, decided := backfillBranch(snap, s)
		if !decided {
			left = append(left, id)
			continue
		}
		if branch == "" {
			continue
		}
		m.update(id, true, func(r *record) {
			if r.s.Branch == "" && r.s.WorktreePath == s.WorktreePath {
				r.s.Branch = branch
			}
		})
		m.log.Info("branch of thread filled in from its worktree", "thread", id, "branch", branch)
	}
	return left
}

// backfillBranch is s's branch read from snap: decided false while s's project has not
// listed its worktrees, else the branch of the worktree at s's path ("" when there is
// none, or it is detached).
func backfillBranch(snap *project.Snapshot, s Thread) (branch string, decided bool) {
	r, ok := snap.Project(s.ProjectID)
	if !ok {
		return "", true
	}
	if len(r.Worktrees) == 0 {
		return "", false
	}
	wt, ok := snap.Worktree(s.ProjectID, s.WorktreePath)
	if !ok || wt.Detached {
		return "", true
	}
	return wt.Branch, true
}
