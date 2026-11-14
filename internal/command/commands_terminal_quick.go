package command

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// Terminals in the shell window's layout (docs/notes/shell-model.md, "Terminals" and the key
// table; docs/notes/shell-6-lifecycle.md): the tab a new shell gets, the thread's quick
// terminal (cmd+j) and the ring of its terminal tabs (cmd+shift+j). No default chords until
// the shell is the window.

// openTerminalTab gives new terminal id a tab: linked to thread and placed by the rules, or,
// for a shell of no thread, unlinked in the focused pane of the current space. From the user
// it takes the focus; from inside a thread it never does. Without a layout it does nothing.
// It returns a phrase for the command's message. pane (a pane's "+" menu) puts
// the tab in that pane instead. terminal.new, terminal.new-free and action.run's terminal runs use it.
func openTerminalTab(ctx context.Context, store layoutstore.Store, uctx Context, thread, id, pane string) (string, error) {
	if store == nil {
		return "", nil
	}
	focus := uctx.FromUser()
	tb := &core.Tab{Kind: "terminal", Thread: thread, Params: map[string]string{core.TerminalParam: id}}
	c, err := layout{store: store}.apply(ctx, &core.OpenSurface{Pane: pane, Tab: tb, Focus: focus}, !focus)
	if err != nil {
		return "", fmt.Errorf("created terminal %s, but could not open its tab: %w", id, err)
	}
	return fmt.Sprintf("; tab %s in pane %s", c.Result.Tab, c.Result.Pane), nil
}

// QuickResult is terminal.quick's JSON.
type QuickResult struct {
	// Rev is the layout commit's (the window waits for it before it moves the keyboard).
	Rev        uint64 `json:"rev"`
	ThreadID   string `json:"thread_id"`
	Open       bool   `json:"open"`
	TerminalID string `json:"terminal_id,omitempty"`
}

// terminalPaneArg is terminal.new's and terminal.new-free's --pane: the pane's "+" menu.
var terminalPaneArg = paneIDArg("pane", "Open the terminal's tab in this pane (the pane's + menu) instead of placing it")

func terminalLayoutCommands(d TerminalDeps, quick *sync.Mutex) []Command {
	l := layout{store: d.Layout}
	return []Command{
		{
			Name:  "terminal.quick",
			Page:  PageState,
			Title: "Toggle Quick Terminal",
			Description: "Open or close a thread's quick terminal, the shell drawn under its conversation in its pane. " +
				"Opening starts it when the thread has none running (one per thread) and, from the app, goes to the thread; " +
				"closing only hides it: the shell keeps running. Default: the thread of the focused tab (a thread or a surface linked to one).",
			Category: "Terminal",
			Args: []ArgSpec{
				layoutThreadArg(false),
				{Name: "open", Type: Bool, Description: "Open it (default: toggle)"},
				{Name: "close", Type: Bool, Description: "Close it (default: toggle)"},
				{Name: "height", Type: Int, Description: "Its height in layout px; alone, it sets the height and keeps it open or closed"},
				focusArg,
			},
			Keybindings: []string{"cmd+j"},
			NoIndex:     true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				snap, err := l.state()
				if err != nil {
					return Result{}, err
				}
				if a.Bool("open") && a.Bool("close") {
					return Result{}, InvalidArg("open", "--open and --close together")
				}
				thread := a.String("id")
				if thread == "" {
					if err := implicit(uctx, "id", "thread"); err != nil {
						return Result{}, err
					}
					_, p, err := focused(snap.State, uctx, "id", "thread")
					if err != nil || p.ActiveTab() == nil || p.ActiveTab().Thread == "" {
						return Result{}, InvalidArg("id", "the focused tab belongs to no thread: name one")
					}
					thread = p.ActiveTab().Thread
				} else if thread, err = l.threadID(ctx, uctx, a); err != nil {
					return Result{}, err
				}
				open := false
				if ts := snap.State.Threads[thread]; ts != nil && ts.Quick != nil {
					open = ts.Quick.Open
				}
				want := !open
				height := a.Int("height")
				if height < 0 {
					return Result{}, InvalidArg("height", "a height below zero")
				}
				switch {
				case a.Has("height") && !a.Bool("open") && !a.Bool("close"):
					// A height drag: the open state stays as it is.
					c, err := l.apply(ctx, &core.SetQuick{Thread: thread, Open: open, Height: float64(height)}, !uctx.FromUser())
					if err != nil {
						return Result{}, err
					}
					out := layoutResult(uctx, c, fmt.Sprintf("thread %s's quick terminal is %d px high", thread, height))
					out.JSON = QuickResult{Rev: c.Rev, ThreadID: thread, Open: open}
					return out, nil
				case a.Bool("open"):
					want = true
				case a.Bool("close"):
					want = false
				}
				focus := wantsFocus(uctx, a)
				res := QuickResult{ThreadID: thread, Open: want}
				msg := "closed thread " + thread + "'s quick terminal"
				if want {
					t, created, err := ensureQuick(ctx, d, quick, uctx, thread)
					if err != nil {
						return Result{}, err
					}
					res.TerminalID = t.GetId()
					msg = "opened thread " + thread + "'s quick terminal " + t.GetId()
					if created {
						msg += " (started)"
					}
					if focus {
						if _, err := l.apply(ctx, &core.OpenThread{Thread: thread, Focus: true}, false); err != nil {
							return Result{}, err
						}
					}
				}
				c, err := l.apply(ctx, &core.SetQuick{Thread: thread, Open: want, Height: float64(height)}, !focus)
				if err != nil {
					return Result{}, err
				}
				out := layoutResult(uctx, c, msg)
				res.Rev = c.Rev
				out.JSON = res
				return out, nil
			},
		},
		{
			Name:  "terminal.cycle",
			Page:  PageState,
			Title: "Cycle Thread Terminals",
			Description: "Focus the next step of a thread's ring: its tab, then each of its terminal tabs in layout order, " +
				"then its tab again. From another surface of the thread it goes to the first terminal. Acts on the focused tab " +
				"(--tab: that one); it only moves the user's focus.",
			Category:    "Terminal",
			Args:        []ArgSpec{tabIDArg("The tab to step from (default: the focused tab)"), focusArg},
			Keybindings: []string{"cmd+shift+j"},
			NoIndex:     true,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				if err := onlyFocus(uctx, a, "terminal.cycle"); err != nil {
					return Result{}, err
				}
				snap, err := l.state()
				if err != nil {
					return Result{}, err
				}
				_, _, tb, err := l.tab(snap.State, uctx, a, "tab")
				if err != nil {
					return Result{}, err
				}
				step, err := core.NextInRing(snap.State, tb.ID)
				if err != nil {
					return Result{}, layoutErr(err)
				}
				var op core.Op = &core.FocusTab{Tab: step.Tab}
				msg := "focused tab " + step.Tab
				switch step.Tab {
				case "":
					op, msg = &core.OpenThread{Thread: step.Thread, Focus: true}, "opened thread "+step.Thread
				case tb.ID:
					msg = "thread " + step.Thread + " has no terminal tab to cycle to"
				}
				c, err := l.apply(ctx, op, false)
				if err != nil {
					return Result{}, err
				}
				return layoutResult(uctx, c, msg), nil
			},
		},
	}
}

// ensureQuick returns thread's running quick terminal, starting one in the thread's checkout
// when it has none (created). quick serializes it with terminal.new --quick and
// terminal.reset, so a thread never gets two.
func ensureQuick(ctx context.Context, d TerminalDeps, quick *sync.Mutex, uctx Context, thread string) (*v1.Terminal, bool, error) {
	quick.Lock()
	defer quick.Unlock()
	running, err := quickTerminal(ctx, d.Terminal, thread)
	if err != nil {
		return nil, false, err
	}
	if running != nil {
		return running, false, nil
	}
	c := uctx
	c.ActiveThreadID = thread
	owner, err := shellOwner(ctx, d.Project, d.Thread, c, "", "", "the quick terminal needs a thread")
	if err != nil {
		return nil, false, err
	}
	if owner.thread == "" {
		return nil, false, connect.NewError(connect.CodeFailedPrecondition, errors.New("no thread "+thread))
	}
	res, err := d.Terminal.Create(ctx, connect.NewRequest(&v1.CreateTerminalRequest{
		Argv: defaultShell(), Cwd: owner.cwd, Labels: termlabel.QuickShell(owner.thread, owner.project, owner.worktree),
	}))
	if err != nil {
		return nil, false, err
	}
	return res.Msg.GetTerminal(), true, nil
}
