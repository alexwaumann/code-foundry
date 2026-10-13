package daemon

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/session"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// reapTimeout bounds one removal: a shell that ignores SIGHUP gets SIGKILL after the
// terminal store's grace period (3s), well inside it.
const reapTimeout = 15 * time.Second

// shellSweepEvery is how often the reaper re-checks every shell, for the events the bus
// dropped (it drops for a full subscriber rather than block).
const shellSweepEvery = 60 * time.Second

// shellReaperOptions configures startShellReaper. Terminals and Bus are required.
type shellReaperOptions struct {
	Log       *slog.Logger
	Terminals terminal.Store
	Bus       *bus.Bus
	// SweepEvery is the sweep interval. Default shellSweepEvery.
	SweepEvery time.Duration
	// DirGone reports whether a worktree directory no longer exists. Default: os.Stat
	// fails with fs.ErrNotExist.
	DirGone func(path string) bool
	// RepoExists and SessionExists let the sweep remove the shells of an unregistered
	// project or a removed thread whose event was dropped. Nil: assume it exists.
	RepoExists    func(id string) bool
	SessionExists func(id string) bool
}

// shellReaper removes the shells terminal.new starts (termlabel.KindShell) once nothing
// shows them. Other terminals (unlabelled ones) are never touched.
//
//   - A shell is removed as soon as it exits.
//   - Its worktree is removed (repo.WorktreeRemoved, from repo.worktree.remove, a
//     workspace removal, or `git worktree remove` outside the app): killed and removed,
//     but only once the directory is gone. The repo store also publishes WorktreeRemoved
//     for every worktree when a refresh fails (it lists none), and that must not kill
//     anything.
//   - Its project is unregistered (repo.RepoRemoved): killed and removed.
//   - Its thread is removed (session.Removed): killed and removed. session.Manager.Remove
//     does it first, synchronously; this catches a shell started while that ran.
//   - Every SweepEvery, and once at start, each of the above is re-checked from the
//     current state, for events the bus dropped.
type shellReaper struct {
	opts   shellReaperOptions
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// startShellReaper starts a shellReaper. The returned func stops it and waits for
// removals in flight (they end with its context).
func startShellReaper(ctx context.Context, opts shellReaperOptions) (func(), error) {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.SweepEvery <= 0 {
		opts.SweepEvery = shellSweepEvery
	}
	if opts.DirGone == nil {
		opts.DirGone = func(path string) bool {
			_, err := os.Stat(path)
			return errors.Is(err, fs.ErrNotExist)
		}
	}
	r := &shellReaper{opts: opts}
	r.ctx, r.cancel = context.WithCancel(ctx)
	// Subscribe before the first sweep, so nothing between the two is missed.
	events, err := opts.Terminals.Watch(r.ctx)
	if err != nil {
		r.cancel()
		return nil, err
	}
	repoEvents := bus.Subscribe[repo.Event](opts.Bus, 256)
	sessionEvents := bus.Subscribe[session.Event](opts.Bus, 256)
	r.sweep()
	r.wg.Go(func() {
		defer repoEvents.Close()
		defer sessionEvents.Close()
		tick := time.NewTicker(opts.SweepEvery)
		defer tick.Stop()
		for {
			select {
			case <-r.ctx.Done():
				return
			case <-tick.C:
				r.sweep()
			case ev, ok := <-events:
				if !ok {
					return
				}
				if t := ev.Updated; t != nil && t.State == terminal.StateExited && termlabel.IsShell(t.Labels) {
					r.remove(t.ID)
				}
			case ev := <-repoEvents.C():
				switch e := ev.(type) {
				case repo.WorktreeRemoved:
					if !opts.DirGone(e.Path) {
						opts.Log.Debug("worktree left the list but is still on disk; its shells stay", "worktree", e.Path)
						continue
					}
					r.reap("worktree removed", termlabel.Worktree, e.Path)
				case repo.RepoRemoved:
					r.reap("project unregistered", termlabel.Repo, e.ID)
				}
			case ev := <-sessionEvents.C():
				if e, ok := ev.(session.Removed); ok {
					r.reap("thread removed", termlabel.Session, e.ID)
				}
			}
		}
	})
	return func() {
		r.cancel()
		r.wg.Wait()
	}, nil
}

// remove forgets an exited shell.
func (r *shellReaper) remove(id string) {
	ctx, cancel := context.WithTimeout(r.ctx, reapTimeout)
	defer cancel()
	if err := r.opts.Terminals.Remove(ctx, id); err != nil && !errors.Is(err, terminal.ErrNotFound) && r.ctx.Err() == nil {
		r.opts.Log.Warn("remove exited shell", "terminal", id, "err", err)
	}
}

// reap kills and removes, in the background, every shell whose label key is value.
func (r *shellReaper) reap(why, key, value string) {
	if value == "" {
		return
	}
	r.wg.Go(func() {
		ctx, cancel := context.WithTimeout(r.ctx, reapTimeout)
		defer cancel()
		n, err := terminal.KillAndRemoveWhere(ctx, r.opts.Terminals, func(t terminal.Terminal) bool {
			return termlabel.IsShell(t.Labels) && t.Labels[key] == value
		})
		if err != nil && r.ctx.Err() == nil {
			r.opts.Log.Warn("remove shells", "why", why, key, value, "err", err)
		}
		if n > 0 {
			r.opts.Log.Info("removed shells", "why", why, key, value, "count", n)
		}
	})
}

// sweep re-checks every shell against the current state.
func (r *shellReaper) sweep() {
	reaped := map[string]bool{} // key + "=" + value, once per sweep
	reap := func(why, key, value string) {
		if !reaped[key+"="+value] {
			reaped[key+"="+value] = true
			r.reap(why, key, value)
		}
	}
	for _, t := range r.opts.Terminals.List(r.ctx) {
		if !termlabel.IsShell(t.Labels) {
			continue
		}
		l := t.Labels
		switch {
		case t.State == terminal.StateExited:
			r.remove(t.ID)
		case l[termlabel.Worktree] != "" && r.opts.DirGone(l[termlabel.Worktree]):
			reap("worktree gone", termlabel.Worktree, l[termlabel.Worktree])
		case l[termlabel.Repo] != "" && r.opts.RepoExists != nil && !r.opts.RepoExists(l[termlabel.Repo]):
			reap("project gone", termlabel.Repo, l[termlabel.Repo])
		case l[termlabel.Session] != "" && r.opts.SessionExists != nil && !r.opts.SessionExists(l[termlabel.Session]):
			reap("thread gone", termlabel.Session, l[termlabel.Session])
		}
	}
}
