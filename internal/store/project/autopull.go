package project

import (
	"context"
	"sync"
)

// Auto pull (docs/notes/auto-pull.md). After each scheduled fetch of a live project,
// once its statuses are refreshed, every checkout on the project's default branch that
// can take a fast-forward (Status.CanFastForward) and is not busy is pulled with
// AutoPull.Pull. The store decides which checkouts qualify; the daemon says whether
// the setting is on, what is busy, and runs the pull (through gitops), so this package
// knows neither threads, actions nor gitops.

// AutoPull is what SetAutoPull hands the store. A nil Enabled, Busy or Pull turns
// auto pull off.
type AutoPull struct {
	// Enabled is read after every scheduled fetch (projects.auto_pull), so a change
	// applies from the next fetch on.
	Enabled func() bool
	// Busy reports whether something works in the checkout at path (symlinks
	// resolved): a thread on a turn, a running action, a git operation. A busy
	// checkout is left for the next fetch.
	Busy func(path string) bool
	// Pull fast-forwards w (`git pull --ff-only`) and reports a refused or failed
	// pull. It may block for the pull's duration: passes run off the fetch loop.
	Pull func(ctx context.Context, w Worktree) error
}

func (a AutoPull) on() bool {
	return a.Enabled != nil && a.Busy != nil && a.Pull != nil && a.Enabled()
}

// autoPullState is the hooks SetAutoPull set and the projects with a pass running.
type autoPullState struct {
	mu      sync.Mutex
	hooks   AutoPull
	running map[string]bool
}

// SetAutoPull replaces the auto pull hooks. The daemon calls it once every store it
// reads exists.
func (g *Git) SetAutoPull(a AutoPull) {
	g.autoPull.mu.Lock()
	defer g.autoPull.mu.Unlock()
	g.autoPull.hooks = a
}

func (g *Git) autoPullHooks() AutoPull {
	g.autoPull.mu.Lock()
	defer g.autoPull.mu.Unlock()
	return g.autoPull.hooks
}

// CanFastForward reports whether a checkout with status st can take `git pull
// --ff-only` without touching anything of its own: it tracks an upstream that has
// commits it lacks and has none the upstream lacks, nothing is staged, modified or
// conflicted, no git operation is in progress, and its last refresh succeeded.
// Untracked files are allowed (unlike HasUncommitted): a fast-forward leaves them
// alone, and git refuses the pull itself when an incoming file would overwrite one.
func (st Status) CanFastForward() bool {
	return st.Upstream != "" && st.Behind > 0 && st.Ahead == 0 &&
		st.Staged == 0 && st.Modified == 0 && st.Conflicted == 0 &&
		st.Operation == "" && st.Error == ""
}

// AutoPullCandidates is p's checkouts an auto pull fast-forwards: those on p's default
// branch (not detached) whose status CanFastForward. Busy checkouts are not filtered
// here.
func AutoPullCandidates(p Project) []Worktree {
	if !p.Git || p.Error != "" || p.DefaultBranch == "" {
		return nil
	}
	var out []Worktree
	for _, w := range p.Worktrees {
		if !w.Detached && w.Branch == p.DefaultBranch && w.Status.CanFastForward() {
			out = append(out, w)
		}
	}
	return out
}

// afterFetch follows a successful scheduled fetch of project id. With auto pull on
// and the project live, a pass refreshes the project and pulls its candidates in the
// background; otherwise (or while the project's last pass still runs) it requests the
// reconcile every fetch is followed by.
func (g *Git) afterFetch(ctx context.Context, id string) {
	a := g.autoPullHooks()
	if !a.on() || !g.projectLive(id, g.now()) || !g.startAutoPull(id) {
		g.sched.request(jobKey{kind: jobReconcile, projectID: id})
		return
	}
	g.wg.Go(func() {
		defer g.endAutoPull(id)
		g.autoPullPass(ctx, id, a)
	})
}

func (g *Git) startAutoPull(id string) bool {
	g.autoPull.mu.Lock()
	defer g.autoPull.mu.Unlock()
	if g.autoPull.running[id] {
		return false
	}
	if g.autoPull.running == nil {
		g.autoPull.running = map[string]bool{}
	}
	g.autoPull.running[id] = true
	return true
}

func (g *Git) endAutoPull(id string) {
	g.autoPull.mu.Lock()
	defer g.autoPull.mu.Unlock()
	delete(g.autoPull.running, id)
}

// autoPullPass refreshes project id (reconcile, base, every status), then pulls each
// candidate that is not busy, one at a time. A refused pull is logged and left for
// the next fetch; a pulled checkout's status is refreshed at once.
func (g *Git) autoPullPass(ctx context.Context, id string, a AutoPull) {
	rctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	err := g.refresh(rctx, id)
	cancel()
	if err != nil {
		return // shutting down, or the refresh hung: the next fetch tries again
	}
	p, ok := g.Snapshot().Project(id)
	if !ok {
		return
	}
	for _, w := range AutoPullCandidates(p) {
		if ctx.Err() != nil {
			return
		}
		if a.Busy(w.Path) {
			g.log.Debug("auto pull skipped: checkout busy", "project", id, "path", w.Path)
			continue
		}
		if err := a.Pull(ctx, w); err != nil {
			if ctx.Err() == nil {
				g.log.Info("auto pull refused; retrying after the next fetch", "project", id, "path", w.Path,
					"upstream", w.Status.Upstream, "err", err)
			}
			continue
		}
		g.log.Info("auto pulled", "project", id, "path", w.Path, "upstream", w.Status.Upstream, "behind", w.Status.Behind)
		g.TouchNow(w.Path)
	}
}
