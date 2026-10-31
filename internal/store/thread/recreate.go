package thread

import (
	"cmp"
	"context"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// Recreating a cleaned-up worktree (docs/notes/recreate-worktree.md). A cleanup
// (project.worktree.cleanup) removes merged worktrees the app made and keeps their
// branches. A thread whose worktree went that way is made whole again when something
// starts its Claude (a message, Reconnect, running): the worktree is made again at the
// same path, so Claude's transcript (keyed by the path) is found and --resume keeps its
// memory. Viewing a thread never recreates anything.
//
// It applies when the cwd is missing, lies under the app's worktrees directory
// (Options.WorktreeRoot) and the row has a branch. Anything else keeps the refusal
// resumeLaunch gives a missing worktree. The branch is the one the worktree had checked
// out when the cleanup removed it (Thread.LastHeads, recorded by RememberHead; it may
// have moved off the created-for branch: the path is the thread's checkout,
// docs/notes/thread-checkouts.md) while that branch exists locally or on origin, else
// the branch the thread was created for (Thread.Branch), as before
// (docs/notes/recreate-last-head.md). The thread's other members' worktrees are made
// again the same way (ensureMembers, placement.go), which records where they land.

// fetchBranchTimeout bounds the fetch that looks for a branch on origin.
const fetchBranchTimeout = 30 * time.Second

// recreatedWorktree is what recreateWorktree made, for the timeline note and the
// worktree-created hook.
type recreatedWorktree struct {
	projectID, path, branch string
	// created is the branch the thread was created for, when branch is another (the
	// worktree's last HEAD); "" otherwise.
	created string
	// base is the ref the branch was made again from, when it was gone locally and on
	// origin; empty when the worktree checked out the existing branch.
	base string
}

// note is the timeline line for a recreated worktree.
func (rw recreatedWorktree) note() string {
	if rw.base == "" {
		return "The worktree was removed and has been recreated from branch " + rw.branch + movedFrom(rw.created) +
			". Untracked and ignored files from before (build output, installed dependencies, local config) are gone."
	}
	return "The worktree was removed and branch " + rw.branch + " no longer existed, so both were recreated from " + rw.base +
		". Commits made on the branch earlier are on it only if they reached " + rw.base +
		" (a merged branch's have), and untracked and ignored files from before are gone."
}

// movedFrom is the note's clause for a worktree made again on its last HEAD, not on
// created, the branch the thread was created for; "" when created is "".
func movedFrom(created string) string {
	if created == "" {
		return ""
	}
	return ", where this thread had moved from " + created
}

// recreatable reports whether s's missing cwd may be made again (see above). A
// workspace reference no longer stops it: ensureMembers makes the other members'
// worktrees again too (checkouts.go).
func (m *Manager) recreatable(s Thread) bool {
	return s.Branch != "" && s.ProjectID != "" && m.opts.Projects != nil &&
		project.InsideRoot(s.WorktreePath, m.opts.WorktreeRoot)
}

// remadeNote is the timeline line for member worktrees ensureMembers made again: on
// their last HEAD (madeWorktree.branch), else on created, the thread's branch. One whose
// branch was gone too (newBranch) says so, as the primary's note does.
func remadeNote(made []madeWorktree, created string) string {
	var branches []string
	paths := map[string][]string{}
	var gone []string
	for _, w := range made {
		branch := cmp.Or(w.branch, created)
		if !w.newBranch {
			if _, ok := paths[branch]; !ok {
				branches = append(branches, branch)
			}
			paths[branch] = append(paths[branch], w.path)
			continue
		}
		start := cmp.Or(w.startPoint, "the default branch")
		gone = append(gone, "The worktree of project "+cmp.Or(w.projectName, w.projectID)+" ("+w.path+") was removed and branch "+branch+
			" no longer existed there, so both were recreated from "+start+". Commits made on the branch there earlier are on it only if they reached "+
			start+" (a merged branch's have), and untracked and ignored files from before are gone.")
	}
	var lines []string
	for _, branch := range branches {
		what := "The worktree of another project of this thread was removed and has been recreated"
		if len(paths[branch]) > 1 {
			what = "The worktrees of other projects of this thread were removed and have been recreated"
		}
		moved := ""
		if branch != created {
			moved = movedFrom(created)
		}
		lines = append(lines, what+" from branch "+branch+moved+" ("+strings.Join(paths[branch], ", ")+"). Untracked and ignored files from before are gone.")
	}
	return strings.Join(append(lines, gone...), " ")
}

// takeoverNote is the timeline line for a member whose removed worktree (was) is not
// made again because another linked worktree has the branch checked out (now): the
// thread works there from now on, as the creation rule shares it (ensureMembers).
func takeoverNote(project, was, now, branch string) string {
	return "The worktree of project " + project + " this thread worked in (" + was + ") was removed, and another worktree has branch " + branch +
		" checked out (" + now + "), so the thread now works there. Files that were only in the removed folder are gone."
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
	m.log.Info("worktree of thread is gone; recreating it", "thread", s.ID, "path", s.WorktreePath, "branch", s.Branch, "last_head", s.LastHeads[s.ProjectID])
	rw, err := m.recreateWorktree(ctx, s)
	if err != nil {
		return nil, err
	}
	m.log.Info("worktree recreated for thread", "thread", s.ID, "path", rw.path, "branch", rw.branch, "base", rw.base)
	m.update(s.ID, false, func(r *record) { r.s.LastHeads = withoutHead(r.s.LastHeads, s.ProjectID) }) // HEAD is live again
	return &rw, nil
}

// recreateWorktree makes s's worktree again through the project store, on the branch
// recreateBranch picks: the worktree's last HEAD (Thread.LastHeads) when it exists, at
// s.WorktreePath (that branch's default path is elsewhere); else s.Branch: the local
// branch when it exists, else origin's (fetched first when no remote-tracking ref has
// it), else a new branch from s.BaseRef (origin/<default branch> when the row has none).
// The result must be at s.WorktreePath: the project store picks the path from the
// project and branch, and resuming in another directory would lose Claude's transcript.
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
	branch, local, remote := recreateBranch(m.lastHead(s, r), s.Branch, func(b string) (bool, bool) { return m.findBranch(ctx, r.Path, b) })
	if err := mainCheckoutBusy(r, branch); err != nil {
		return recreatedWorktree{}, err // never a second worktree on that branch
	}
	rw := recreatedWorktree{projectID: r.ID, branch: branch}
	opts := project.CreateWorktreeOptions{ProjectID: r.ID, Branch: branch, Fetch: true, BaseFromOrigin: m.opts.BaseFromOrigin()}
	if branch != s.Branch {
		rw.created, opts.Path = s.Branch, s.WorktreePath
	}
	if !local && !remote {
		// No BaseRef: the project store's default base (origin/<default>, fetched,
		// unless the local default is ahead of it or projects.base_from_origin is off:
		// then the local default).
		opts.BaseRef = s.BaseRef
	}
	wt, err := m.opts.Projects.CreateWorktree(ctx, opts)
	if err != nil {
		return recreatedWorktree{}, projectError("recreate worktree "+branch, err)
	}
	if !local && !remote {
		rw.base = cmp.Or(wt.StartPoint, s.BaseRef, wt.Status.BaseRef, "origin/"+cmp.Or(r.DefaultBranch, "main"))
	}
	if !samePath(wt.Path, s.WorktreePath) {
		return recreatedWorktree{}, fmt.Errorf("%w: recreated the worktree of branch %s at %s, not at the thread's %s; "+
			"not resuming in another directory (Claude's conversation is kept by path)", ErrFailedPrecondition, branch, wt.Path, s.WorktreePath)
	}
	rw.path = s.WorktreePath
	return rw, nil
}

// recreateBranch is the branch to make a removed worktree-mode checkout again on, and
// where it is: last (its HEAD when a cleanup removed it) when that exists locally or on
// origin, else created (the branch the thread was created for), as before. find reports
// where a branch is (the local branch, else a remote-tracking ref or a targeted fetch);
// created is looked up only when last is not found. Pure apart from find.
func recreateBranch(last, created string, find func(string) (local, remote bool)) (branch string, local, remote bool) {
	if last != "" && last != created {
		if local, remote = find(last); local || remote {
			return last, local, remote
		}
	}
	local, remote = find(created)
	return created, local, remote
}

// lastHead is the branch s's checkout of r had when a cleanup removed it, when it is not
// s's created-for branch; "" when none is recorded, and when r's main checkout has it
// checked out now (no second worktree on it: the created-for branch instead, logged).
func (m *Manager) lastHead(s Thread, r project.Project) string {
	last := s.LastHeads[r.ID]
	if last == "" || last == s.Branch {
		return ""
	}
	if _, busy := mainOnBranch(r, last); busy {
		m.log.Info("last branch of a removed worktree is checked out in the project's main checkout; using the thread's branch",
			"thread", s.ID, "project", r.ID, "last_head", last, "branch", s.Branch)
		return ""
	}
	return last
}

// findBranch reports whether branch is a local branch of the repository at dir, else on
// origin: a remote-tracking ref, or found by a targeted fetch (Options.FetchBranch).
func (m *Manager) findBranch(ctx context.Context, dir, branch string) (local, remote bool) {
	local = m.opts.RefExists(ctx, dir, "refs/heads/"+branch)
	remote = !local && (m.opts.RefExists(ctx, dir, "refs/remotes/origin/"+branch) || m.opts.FetchBranch(ctx, dir, branch))
	return local, remote
}

// RememberHead records w's branch as the last HEAD (Thread.LastHeads) of every thread
// whose worktree-mode checkout of w's project is at w's path: the daemon's cleanups call
// it right before they remove w (project.CleanupOptions.Removing), since the project
// snapshot forgets HEAD with the worktree. A detached HEAD, or the created-for branch,
// drops the entry: the created-for branch is then the one made again. Persisted.
func (m *Manager) RememberHead(w project.Worktree) {
	if w.Path == "" || w.IsMain || w.ProjectID == "" {
		return
	}
	at := func(t Thread) bool {
		p, ok := t.CheckoutPath(w.ProjectID)
		return t.worktreeMode() && ok && samePath(p, w.Path)
	}
	for _, t := range m.Snapshot().Threads {
		if !at(t) {
			continue
		}
		branch := w.Branch
		if w.Detached || branch == t.Branch {
			branch = ""
		}
		if t.LastHeads[w.ProjectID] == branch {
			continue
		}
		m.update(t.ID, true, func(r *record) {
			if at(r.s) {
				r.s.LastHeads = withHead(r.s.LastHeads, w.ProjectID, branch)
			}
		})
		m.log.Info("branch of a worktree a cleanup removes recorded for its thread", "thread", t.ID, "project", w.ProjectID, "path", w.Path, "last_head", branch)
	}
}

// withHead is heads with projectID's last HEAD set to branch ("" deletes it); copy on
// write, nil when empty.
func withHead(heads map[string]string, projectID, branch string) map[string]string {
	out := maps.Clone(heads)
	if branch == "" {
		delete(out, projectID)
	} else {
		if out == nil {
			out = map[string]string{}
		}
		out[projectID] = branch
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// withoutHead is heads without projectID's entry (copy on write).
func withoutHead(heads map[string]string, projectID string) map[string]string {
	if _, ok := heads[projectID]; !ok {
		return heads
	}
	return withHead(heads, projectID, "")
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

// backfillLimit is how long backfillBranches and fillCheckouts wait for projects to list
// their worktrees.
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

// startBackfill runs backfillBranches, then fillCheckouts, in the background when some
// row needs them.
func (m *Manager) startBackfill() {
	branches, checkouts := m.backfillPending(), m.fillPending()
	if (len(branches) == 0 && len(checkouts) == 0) || m.opts.Projects == nil {
		return
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.backfillBranches(branches, m.opts.Tick, backfillLimit)
		m.fillCheckouts(checkouts, m.opts.Tick, backfillLimit)
	}()
}

// backfillBranches checks pending against the project snapshot every tick until each
// is decided, Shutdown, or limit passed.
func (m *Manager) backfillBranches(pending []string, tick, limit time.Duration) {
	m.untilDecided(pending, tick, limit, m.backfillStep, func(left []string) {
		m.log.Info("branches of threads not filled in: their projects did not list worktrees", "threads", len(left))
	})
}

// untilDecided runs step over pending every tick until it decides them all, Shutdown,
// or limit passed; then late gets what is left.
func (m *Manager) untilDecided(pending []string, tick, limit time.Duration, step func([]string) []string, late func([]string)) {
	if len(pending) == 0 {
		return
	}
	t := time.NewTicker(tick)
	defer t.Stop()
	deadline := time.Now().Add(limit)
	for {
		pending = step(pending)
		if len(pending) == 0 {
			return
		}
		if time.Now().After(deadline) {
			late(pending)
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

// Rows from before the checkouts column (migration 0049) record no checkouts.
// fillCheckouts records them once their projects have listed their worktrees: each
// member's checkout as the derivation it replaces gave it then (fillPaths), "" for one
// whose worktree is missing (its next start makes it on the thread's branch, at that same
// default path). Until then they resolve as before (resolveMember), so a start meanwhile
// behaves as it did.

// fillPending are the threads with projects and no checkouts recorded.
func (m *Manager) fillPending() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var ids []string
	for id, rec := range m.recs {
		if rec.s.CheckoutPaths == nil && len(rec.s.Projects()) > 0 {
			ids = append(ids, id)
		}
	}
	return ids
}

// fillCheckouts records pending's checkouts every tick until each is decided, Shutdown,
// or limit passed; past it, members still undecided are recorded "" (resolved at their
// thread's next start).
func (m *Manager) fillCheckouts(pending []string, tick, limit time.Duration) {
	m.untilDecided(pending, tick, limit, func(p []string) []string { return m.fillStep(p, false) }, func(left []string) {
		m.log.Info("checkouts of threads recorded without their projects' worktrees listed", "threads", len(left))
		m.fillStep(left, true)
	})
}

// fillStep records what it can of pending's checkouts against the current project
// snapshot (all of them with force) and returns the threads still undecided.
func (m *Manager) fillStep(pending []string, force bool) []string {
	snap := m.opts.Projects.Snapshot()
	if snap == nil && !force {
		return pending
	}
	var left []string
	for _, id := range pending {
		s, ok := m.Snapshot().Thread(id)
		if !ok || s.CheckoutPaths != nil {
			continue
		}
		paths, decided := fillPaths(s, snap, m.opts.Projects.DefaultWorktreePath, isDir, force)
		if !decided {
			left = append(left, id)
			continue
		}
		m.update(id, true, func(r *record) {
			if r.s.CheckoutPaths == nil && r.s.WorktreePath == s.WorktreePath && r.s.ProjectID == s.ProjectID {
				r.s.CheckoutPaths = paths
			}
		})
		m.log.Info("checkouts of thread recorded from its derivation", "thread", id, "checkouts", paths)
	}
	return left
}
