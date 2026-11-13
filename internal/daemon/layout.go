package daemon

import (
	"cmp"
	"context"
	"errors"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// The glue between the thread and terminal stores and the layout store
// (docs/ARCHITECTURE.md §14, docs/notes/shell-6-lifecycle.md). The layout store
// never looks at threads or terminals; this file turns their events into layout ops, and the
// layout's commits into what they mean for terminals:
//
//   - A new thread joins its creator's space, else the current space. (A user's thread sent
//     from a composer tab takes the composer's place: thread.new --compose applies that.)
//     An unarchived thread joins the current space.
//   - A thread being archived, snoozed or removed (thread.Options.ShellsGoing, called before
//     its shells go): archive_thread or snooze_thread. A snooze first reads what runs in each
//     of its terminals, for the "Run again" line of the fresh shell that replaces it.
//   - A removed thread: archive_thread, which drops whatever the layout still has of it.
//   - A terminal removed (a shell is removed as soon as it exits): its tab closes and a thread
//     forgets it (drop_terminal). A thread's quick terminal removed: the quick terminal is
//     drawn closed (set_quick). A shell labelled replaces=<old> (terminal.reset): the old
//     terminal's tab follows it (replace_terminal).
//   - A commit that closed terminal tabs by themselves (Result.Closed) or ended a thread's
//     terminals (Result.Ended): those terminals end. Tabs closed with their thread
//     (Result.Kept) keep theirs running. A commit that restored fresh shells (Result.Fresh,
//     after a snooze): a new shell for each, and the tab follows it.
//
// The glue's own ops carry no client id. A sweep at start and every layoutSweepEvery drops
// what the layout holds of terminals that are gone (after a restart every terminal is), for
// the events the bus dropped.

// layoutSweepEvery is how often the glue re-checks the layout's terminals.
const layoutSweepEvery = 60 * time.Second

// layoutGlueOptions configures startLayoutGlue. Every field but Log, Shell and SweepEvery is
// required.
type layoutGlueOptions struct {
	Log       *slog.Logger
	Layout    layoutstore.Store
	Terminals terminal.Store
	// Threads is the thread store's snapshot now.
	Threads func() *thread.Snapshot
	// Bus carries thread.Event and layoutstore.Event.
	Bus *bus.Bus
	// Shell is the argv of a fresh shell. Default: $SHELL -l.
	Shell func() []string
	// SweepEvery is the sweep interval. Default layoutSweepEvery.
	SweepEvery time.Duration
}

type layoutGlue struct {
	opts   layoutGlueOptions
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	// labels are each terminal's labels as last seen: a removal names only the id.
	labels map[string]map[string]string
	// archived is, for each thread seen, whether it was archived: a thread not in it is new,
	// one that goes from true to false was unarchived.
	archived map[string]bool
}

// startLayoutGlue starts the glue's loop. The returned func stops it and waits for terminals
// it is ending (they end with its context).
func startLayoutGlue(ctx context.Context, opts layoutGlueOptions) (func(), error) {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.Shell == nil {
		opts.Shell = loginShell
	}
	if opts.SweepEvery <= 0 {
		opts.SweepEvery = layoutSweepEvery
	}
	g := &layoutGlue{opts: opts, labels: map[string]map[string]string{}, archived: map[string]bool{}}
	g.ctx, g.cancel = context.WithCancel(ctx)
	// Subscribe before reading the state, so nothing between the two is missed.
	terms, err := opts.Terminals.Watch(g.ctx)
	if err != nil {
		g.cancel()
		return nil, err
	}
	threadEvents := bus.Subscribe[thread.Event](opts.Bus, 256)
	layoutEvents := bus.Subscribe[layoutstore.Event](opts.Bus, 256)
	for _, t := range opts.Terminals.List(g.ctx) {
		g.labels[t.ID] = t.Labels
	}
	if snap := opts.Threads(); snap != nil {
		for _, t := range snap.Threads {
			g.archived[t.ID] = !t.ArchivedAt.IsZero()
		}
	}
	g.sweep()
	g.wg.Go(func() {
		defer threadEvents.Close()
		defer layoutEvents.Close()
		tick := time.NewTicker(opts.SweepEvery)
		defer tick.Stop()
		for {
			select {
			case <-g.ctx.Done():
				return
			case <-tick.C:
				g.sweep()
			case ev, ok := <-terms:
				if !ok {
					return
				}
				g.terminalEvent(ev)
			case ev := <-threadEvents.C():
				g.threadEvent(ev)
			case ev := <-layoutEvents.C():
				g.layoutEvent(ev)
			}
		}
	})
	return func() {
		g.cancel()
		g.wg.Wait()
	}, nil
}

// loginShell is the user's login shell, as terminal.new starts it.
func loginShell() []string {
	sh := os.Getenv("SHELL")
	if sh == "" {
		sh = "/bin/zsh"
	}
	return []string{sh, "-l"}
}

// apply runs one of the glue's ops; a failure is logged, never fatal.
func (g *layoutGlue) apply(op core.Op) (layoutstore.Commit, bool) {
	return applyLayout(g.ctx, g.opts.Log, g.opts.Layout, op)
}

func applyLayout(ctx context.Context, log *slog.Logger, l layoutstore.Store, op core.Op) (layoutstore.Commit, bool) {
	c, err := l.Apply(ctx, op, layoutstore.ApplyOptions{})
	if err != nil {
		if !errors.Is(err, layoutstore.ErrClosed) && ctx.Err() == nil {
			log.Warn("layout: apply", "op", op.OpName(), "err", err)
		}
		return c, false
	}
	return c, true
}

func (g *layoutGlue) state() *core.State { return g.opts.Layout.Snapshot().State }

// threadEvent places new threads and unarchived ones, and drops what the layout has of a
// removed one.
func (g *layoutGlue) threadEvent(ev thread.Event) {
	switch e := ev.(type) {
	case thread.Updated:
		t := e.Thread
		was, seen := g.archived[t.ID]
		g.archived[t.ID] = !t.ArchivedAt.IsZero()
		switch {
		case t.Removing || t.Owner != "":
			// going, or someone else's (a plugin's): not in any space's list
		case !seen:
			g.joinSpace(t, true)
		case was && t.ArchivedAt.IsZero():
			g.joinSpace(t, false)
		}
	case thread.Removed:
		delete(g.archived, e.ID)
		g.apply(&core.ArchiveThread{Thread: e.ID})
	}
}

// joinSpace moves thread t to the space it belongs in now: a new thread (created) to its
// creator's space, else to the current space; an unarchived one to the current space. A new
// thread the layout already knows (thread.new --compose placed it) stays where it is.
func (g *layoutGlue) joinSpace(t thread.Thread, created bool) {
	st := g.state()
	if created && (st.Threads[t.ID] != nil || threadOpen(st, t.ID)) {
		return
	}
	to := st.CurrentSpace
	if created && t.CreatedBy != "" {
		to = st.SpaceOf(t.CreatedBy)
	}
	if to == st.SpaceOf(t.ID) {
		return
	}
	g.apply(&core.MoveThreadToSpace{Thread: t.ID, Space: to})
}

// threadOpen reports whether thread has its tab open.
func threadOpen(st *core.State, thread string) bool {
	for _, sp := range st.Spaces {
		for _, p := range core.Panes(sp.Root) {
			for _, tb := range p.Tabs {
				if tb.Kind == "thread" && tb.Thread == thread {
					return true
				}
			}
		}
	}
	return false
}

// terminalEvent follows a reset shell with its old tab, and drops a terminal that went away.
func (g *layoutGlue) terminalEvent(ev terminal.Event) {
	if t := ev.Updated; t != nil {
		_, seen := g.labels[t.ID]
		g.labels[t.ID] = t.Labels
		if old := t.Labels[termlabel.Replaces]; !seen && old != "" && core.Holds(g.state(), old) {
			g.apply(&core.ReplaceTerminal{Old: old, New: t.ID})
		}
		return
	}
	id := ev.RemovedID
	labels := g.labels[id]
	delete(g.labels, id)
	g.gone(id, labels)
}

// gone is what a terminal that no longer exists means to the layout: a quick terminal is
// drawn closed unless its thread has another; a terminal a reset replaced has its tab follow
// the new one (the removal may arrive before the new shell's first event); any other has its
// tab closed and is forgotten.
func (g *layoutGlue) gone(id string, labels map[string]string) {
	st := g.state()
	if termlabel.IsQuick(labels) {
		th := labels[termlabel.Thread]
		if ts := st.Threads[th]; ts != nil && ts.Quick != nil && ts.Quick.Open && !g.hasQuick(th) {
			g.apply(&core.SetQuick{Thread: th, Open: false})
		}
		return
	}
	if !core.Holds(st, id) {
		return
	}
	for _, t := range g.opts.Terminals.List(g.ctx) {
		if t.Labels[termlabel.Replaces] == id {
			g.apply(&core.ReplaceTerminal{Old: id, New: t.ID})
			return
		}
	}
	g.apply(&core.DropTerminal{Terminal: id})
}

// hasQuick reports whether thread has a running quick terminal.
func (g *layoutGlue) hasQuick(thread string) bool {
	for _, t := range g.opts.Terminals.List(g.ctx) {
		if termlabel.IsQuick(t.Labels) && t.Labels[termlabel.Thread] == thread && t.State != terminal.StateExited {
			return true
		}
	}
	return false
}

// layoutEvent ends the terminals a commit closed by themselves or ended, and starts the
// fresh shells it restored.
func (g *layoutGlue) layoutEvent(ev layoutstore.Event) {
	if ev.Op == "drop_terminal" {
		return // its terminal is gone already
	}
	var end []string
	for _, tb := range ev.Result.Closed {
		if tb.Kind == "terminal" {
			end = append(end, tb.Params[core.TerminalParam])
		}
	}
	for _, tb := range ev.Result.Ended {
		end = append(end, tb.Params[core.TerminalParam])
	}
	st := g.state()
	for _, id := range end {
		if id != "" && !core.Holds(st, id) {
			g.end(id)
		}
	}
	for _, tab := range ev.Result.Fresh {
		g.fresh(tab)
	}
}

// end kills and removes terminal id in the background: a shell or an action run (what
// terminal.close ends), never a plugin's terminal or an unlabelled one, which their owners
// end.
func (g *layoutGlue) end(id string) {
	t, err := g.opts.Terminals.Get(g.ctx, id)
	if err != nil || !termlabel.IsPanel(t.Labels) {
		return
	}
	g.wg.Go(func() {
		ctx, cancel := context.WithTimeout(g.ctx, reapTimeout)
		defer cancel()
		if err := terminal.KillAndRemove(ctx, g.opts.Terminals, id); err != nil && g.ctx.Err() == nil {
			g.opts.Log.Warn("layout: end the terminal of a closed tab", "terminal", id, "err", err)
		}
	})
}

// fresh starts a new shell for terminal tab id, restored after a snooze, in its thread's
// checkout, and points the tab at it. A thread with no checkout (or gone) gets no shell, and
// the tab closes.
func (g *layoutGlue) fresh(tabID string) {
	_, _, tb := g.state().FindTab(tabID)
	if tb == nil || tb.Kind != "terminal" {
		return
	}
	old := tb.Params[core.TerminalParam]
	th, ok := g.opts.Threads().Thread(tb.Thread)
	if !ok || th.WorktreePath == "" {
		g.opts.Log.Info("layout: no checkout for a restored terminal; its tab closes", "thread", tb.Thread, "tab", tabID)
		g.apply(&core.CloseTab{Tab: tabID})
		return
	}
	t, err := g.opts.Terminals.Create(g.ctx, terminal.Spec{
		Argv: g.opts.Shell(), Cwd: th.WorktreePath, Labels: termlabel.Shell(th.ID, th.ProjectID, th.WorktreePath),
	})
	if err != nil {
		g.opts.Log.Warn("layout: start a restored terminal; its tab closes", "thread", th.ID, "tab", tabID, "err", err)
		g.apply(&core.CloseTab{Tab: tabID})
		return
	}
	g.labels[t.ID] = t.Labels
	g.apply(&core.ReplaceTerminal{Old: old, New: t.ID})
}

// sweep drops what the layout holds of terminals that no longer exist, and draws closed the
// quick terminals that have no shell.
func (g *layoutGlue) sweep() {
	st := g.state()
	for _, id := range core.HeldTerminals(st) {
		if _, err := g.opts.Terminals.Get(g.ctx, id); errors.Is(err, terminal.ErrNotFound) {
			g.gone(id, nil)
		}
	}
	for th, ts := range st.Threads {
		if ts.Quick != nil && ts.Quick.Open && !g.hasQuick(th) {
			g.apply(&core.SetQuick{Thread: th, Open: false})
		}
	}
}

// layoutShellsGoing is the thread store's ShellsGoing: before a thread's shells go, the
// layout closes its tabs. An archive or a removal forgets the thread (archive_thread); a
// snooze keeps its set, its terminals to come back as fresh shells, each with the command
// it was running (the foreground job, else the last one) for its "Run again" line. It runs
// before the shells go, so that command can still be read.
func layoutShellsGoing(log *slog.Logger, l layoutstore.Store, terms terminal.Store) func(context.Context, string, thread.ShellsGo) {
	return func(ctx context.Context, id string, why thread.ShellsGo) {
		ctx = context.WithoutCancel(ctx)
		if why != thread.ShellsSnoozed {
			applyLayout(ctx, log, l, &core.ArchiveThread{Thread: id})
			return
		}
		ran := map[string]string{}
		for _, term := range threadTerminals(l.Snapshot().State, id) {
			t, err := terms.Get(ctx, term)
			if err != nil {
				continue
			}
			if cmd := cmp.Or(t.Foreground, t.LastCommand); cmd != "" {
				ran[term] = cmd
			}
		}
		applyLayout(ctx, log, l, &core.SnoozeThread{Thread: id, Ran: ran})
	}
}

// threadTerminals lists the terminals of thread's terminal tabs: open ones and remembered
// ones still running.
func threadTerminals(st *core.State, thread string) []string {
	var out []string
	for _, sp := range st.Spaces {
		for _, p := range core.Panes(sp.Root) {
			for _, tb := range p.Tabs {
				if tb.Kind == "terminal" && tb.Thread == thread {
					out = append(out, tb.Params[core.TerminalParam])
				}
			}
		}
	}
	if ts := st.Threads[thread]; ts != nil && ts.Remembered != nil {
		for _, rt := range ts.Remembered.Tabs {
			if rt.Tab.Kind == "terminal" && rt.Fresh == nil {
				out = append(out, rt.Tab.Params[core.TerminalParam])
			}
		}
	}
	return out
}
