package daemon

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Cleanup on archive (docs/notes/workspaces-v2-1-threads.md). When a thread is
// archived, each of its worktree-mode checkouts (thread.Checkout.WorktreeMode: any member
// that has git, at the path the thread records, whatever it has checked out; never a
// main checkout; docs/notes/thread-checkouts.md) goes
// at once when the app made it, its status is clean with no operation in progress
// (project.ArchivedVerdict), no other thread that is not archived has it as a checkout
// or its cwd, and no terminal is open in it
// (cleanupHold). Never its branch. Runs in the background, after the archive. A removed
// thread's go the same way, after the removal (Options.Removed;
// docs/notes/remove-cleans-worktrees.md): the abandoned sweep (cleanup.go) stays the
// backstop for what neither reaches.

// archiveCleanupTimeout bounds one archived or removed thread's cleanup (a refresh per
// member).
const archiveCleanupTimeout = 2 * time.Minute

// archiveCleaner removes archived and removed threads' worktree-mode worktrees.
type archiveCleaner struct {
	log       *slog.Logger
	projects  project.Store
	checkouts func(thread.Thread) []thread.Checkout
	threads   func() *thread.Snapshot
	terminals func() []terminal.Terminal
	// remember records a worktree's HEAD for its threads right before it goes
	// (beforeRemoval); nil: nothing.
	remember func(project.Worktree)
	// pathLocks serialize cleanups of one worktree path (cleanOne): path -> *sync.Mutex.
	pathLocks sync.Map
	wg        sync.WaitGroup
	ctx       context.Context
	cancel    context.CancelFunc
}

// stop cancels the cleanups running now and waits for them.
func (c *archiveCleaner) stop() {
	c.cancel()
	c.wg.Wait()
}

// archived is thread.Options.Archived: it starts t's cleanup and returns at once.
func (c *archiveCleaner) archived(t thread.Thread) { c.start(t, "archived") }

// removed is thread.Options.Removed: the same for a thread just removed (t as it was;
// it is no longer in the snapshot, so it holds nothing itself).
func (c *archiveCleaner) removed(t thread.Thread) { c.start(t, "removed") }

// start runs t's cleanup in the background; cause ("archived", "removed") goes in the log.
func (c *archiveCleaner) start(t thread.Thread, cause string) {
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		ctx, cancel := context.WithTimeout(c.ctx, archiveCleanupTimeout)
		defer cancel()
		c.clean(ctx, t, cause)
	}()
}

// clean removes t's worktree-mode worktrees that nothing else holds.
func (c *archiveCleaner) clean(ctx context.Context, t thread.Thread, cause string) {
	for _, co := range c.checkouts(t) {
		if !co.WorktreeMode || co.Missing || !co.Registered || co.Path == "" {
			continue
		}
		c.cleanOne(ctx, cause, "thread", t.ID, co.ProjectID, co.Path)
	}
}

// cleanOne runs the archived verdict on one worktree (cause is "archived", "removed" or
// "unregistering", by "thread" or "project", id its id, for the log). Cleanups of one
// path run one at a time: threads archived
// together that share a worktree each start one, and the later ones find it no longer
// listed (NotFound after Cleanup's refresh) instead of failing on a worktree git just
// removed.
func (c *archiveCleaner) cleanOne(ctx context.Context, cause, by, id, projectID, path string) {
	v, _ := c.pathLocks.LoadOrStore(filepath.Clean(path), &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	res, err := project.Cleanup(ctx, c.projects, project.CleanupOptions{
		ProjectID: projectID, Path: path, Verdict: project.ArchivedVerdict,
		Hold: func(w project.Worktree) string {
			return cleanupHold(w.Path, checkoutThreads(c.threads(), c.checkouts), c.terminals())
		},
		Removing: beforeRemoval(c.log, func(w project.Worktree) {
			if c.remember != nil {
				c.remember(w)
			}
		}),
	})
	switch {
	case errors.Is(err, project.ErrNotFound):
		c.log.Debug("worktree already removed", by, id, "cause", cause, "project", projectID, "path", path)
	case err != nil:
		c.log.Warn("worktree not cleaned up", by, id, "cause", cause, "project", projectID, "path", path, "err", err)
	case len(res.Removed) > 0:
		c.log.Info("worktree removed (its branch stays)", by, id, "cause", cause, "project", projectID, "path", path)
	case len(res.Skipped) > 0:
		c.log.Info("worktree kept", by, id, "cause", cause, "project", projectID, "path", path, "reason", res.Skipped[0].Reason)
	}
}

// unregistering is the project API's hook before a project is unregistered
// (api.Project.WithBeforeUnregister): the worktrees Code Foundry made for it that no
// thread that is not archived uses go through the archived verdict, as an archive's do
// (clean: removed; never a branch), since nothing removes them once the project is gone.
// Synchronous, bounded by archiveCleanupTimeout.
func (c *archiveCleaner) unregistering(ctx context.Context, projectID string) {
	r, ok := c.projects.Snapshot().Project(projectID)
	if !ok || !r.Git {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, archiveCleanupTimeout)
	defer cancel()
	for _, w := range r.Worktrees {
		if w.IsMain || !w.Managed {
			continue
		}
		c.cleanOne(ctx, "unregistering", "project", projectID, projectID, w.Path)
	}
}

// checkoutThreads is worktreeThreads with every checkout of each thread that is not
// archived (checkouts.go), not only its cwd: what the cleanup holds keep.
func checkoutThreads(snap *thread.Snapshot, checkouts func(thread.Thread) []thread.Checkout) []holder {
	out := worktreeThreads(snap)
	if snap == nil {
		return out
	}
	for _, s := range snap.Threads {
		if !s.ArchivedAt.IsZero() {
			continue
		}
		for _, co := range checkouts(s) {
			if !co.Primary && co.Path != "" {
				out = append(out, holder{ID: s.ID, Name: s.Name, Cwd: co.Path})
			}
		}
	}
	return out
}
