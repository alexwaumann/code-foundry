package daemon

import (
	"context"
	"errors"
	"path/filepath"

	"github.com/alexwaumann/code-foundry/internal/store/action"
	"github.com/alexwaumann/code-foundry/internal/store/gitops"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Auto pull (docs/notes/auto-pull.md): the project store picks the checkouts after
// each scheduled fetch; the daemon reads projects.auto_pull, decides what is busy from
// the thread, action and gitops snapshots, and pulls through gitops so the op shows in
// the worktree panel and gitops history.

// autoPullSources is what the auto pull hooks read; each func returns the store's
// current snapshot (nil while that store does not exist).
type autoPullSources struct {
	enabled func() bool
	threads func() *thread.Snapshot
	actions func() *action.Snapshot
	ops     gitops.Store
}

// autoPullHooks builds the project store's auto pull hooks.
func autoPullHooks(src autoPullSources) project.AutoPull {
	return project.AutoPull{
		Enabled: src.enabled,
		Busy: func(path string) bool {
			return checkoutBusy(path, src.threads(), src.actions(), src.ops.Snapshot())
		},
		Pull: func(ctx context.Context, w project.Worktree) error {
			op, err := src.ops.Pull(ctx, gitops.PullOptions{WorktreePath: w.Path, Title: "Auto pull " + w.Status.Upstream})
			if err != nil {
				return err
			}
			if !op.OK() {
				return errors.New(op.Summary)
			}
			return nil
		},
	}
}

// autoPullEnabled reads projects.auto_pull at each call, so a change applies from the
// next fetch on.
func autoPullEnabled(st *settings.Store) func() bool {
	return func() bool { return st.Settings().Projects.AutoPull }
}

// checkoutBusy reports whether something works in the checkout at path (symlinks
// resolved): a thread on a turn (busy, not merely connected), a running action, or a
// queued or running git operation (which would put the pull behind it).
func checkoutBusy(path string, threads *thread.Snapshot, actions *action.Snapshot, ops *gitops.Snapshot) bool {
	if threads != nil {
		for _, th := range threads.Threads {
			if th.Status == thread.StatusBusy && samePath(th.WorktreePath, path) {
				return true
			}
		}
	}
	if actions != nil {
		for _, r := range actions.Runs {
			if r.State == action.RunRunning && samePath(r.Worktree, path) {
				return true
			}
		}
	}
	if ops != nil {
		for _, o := range ops.Ops {
			if !o.State.Finished() && samePath(o.WorktreePath, path) {
				return true
			}
		}
	}
	return false
}

// samePath reports whether p names the directory resolved (already symlink-resolved),
// resolving p's symlinks only when the cleaned paths differ.
func samePath(p, resolved string) bool {
	if p == "" {
		return false
	}
	p = filepath.Clean(p)
	if p == resolved {
		return true
	}
	real, err := filepath.EvalSymlinks(p)
	return err == nil && real == resolved
}
