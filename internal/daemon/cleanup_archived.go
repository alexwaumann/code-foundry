package daemon

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Cleanup on archive (docs/notes/workspaces-v2-1-threads.md). When a thread is
// archived, each of its derived worktrees (worktree mode, any member that has git) goes
// at once when the app made it, its status is clean with no operation in progress
// (project.ArchivedVerdict), no other thread that is not archived has it as a checkout
// or its cwd, no terminal is open in it, and no v1 workspace has it as a member
// (cleanupHold). Never its branch. Runs in the background, after the archive.

// archiveCleanupTimeout bounds one archived thread's cleanup (a refresh per member).
const archiveCleanupTimeout = 2 * time.Minute

// archiveCleaner removes archived threads' derived worktrees.
type archiveCleaner struct {
	log        *slog.Logger
	projects   project.Store
	checkouts  func(thread.Thread) []thread.Checkout
	threads    func() *thread.Snapshot
	terminals  func() []terminal.Terminal
	workspaces func() *workspace.Snapshot
	wg         sync.WaitGroup
	ctx        context.Context
	cancel     context.CancelFunc
}

// stop cancels the cleanups running now and waits for them.
func (c *archiveCleaner) stop() {
	c.cancel()
	c.wg.Wait()
}

// archived is thread.Options.Archived: it starts t's cleanup and returns at once.
func (c *archiveCleaner) archived(t thread.Thread) {
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		ctx, cancel := context.WithTimeout(c.ctx, archiveCleanupTimeout)
		defer cancel()
		c.clean(ctx, t)
	}()
}

// clean removes t's derived worktrees that nothing else holds.
func (c *archiveCleaner) clean(ctx context.Context, t thread.Thread) {
	for _, co := range c.checkouts(t) {
		if !co.Derived || co.Missing || !co.Registered || co.Path == "" {
			continue
		}
		res, err := project.Cleanup(ctx, c.projects, project.CleanupOptions{
			ProjectID: co.ProjectID, Path: co.Path, Verdict: project.ArchivedVerdict,
			Hold: func(w project.Worktree) string {
				return cleanupHold(w.Path, checkoutThreads(c.threads(), c.checkouts), c.terminals(), c.workspaces())
			},
			Removing: logLeftovers(c.log),
		})
		switch {
		case err != nil:
			c.log.Warn("archived thread's worktree not cleaned up", "thread", t.ID, "project", co.ProjectID, "path", co.Path, "err", err)
		case len(res.Removed) > 0:
			c.log.Info("archived thread's worktree removed (its branch stays)", "thread", t.ID, "project", co.ProjectID,
				"path", co.Path, "branch", co.Branch)
		case len(res.Skipped) > 0:
			c.log.Info("archived thread's worktree kept", "thread", t.ID, "project", co.ProjectID, "path", co.Path,
				"reason", res.Skipped[0].Reason)
		}
	}
}

// checkoutThreads is worktreeThreads with every checkout of each thread that is not
// archived (checkouts.go), not only its cwd: what the cleanup holds keep.
func checkoutThreads(snap *thread.Snapshot, checkouts func(thread.Thread) []thread.Checkout) []workspace.Thread {
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
				out = append(out, workspace.Thread{ID: s.ID, Name: s.Name, Cwd: co.Path})
			}
		}
	}
	return out
}
