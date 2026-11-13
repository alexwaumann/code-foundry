package command

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// The terminals of the shell window (docs/notes/shell-model.md, "Terminals"): a free shell
// that belongs to no thread or project, a reset that starts a fresh shell in the owner's
// directory, and "Run again" for the last command.

// commandCut is how the daemon ends a command line it cut at its cap (Terminal.foreground
// and last_command; terminal.CommandCut). A quoted line never ends in it.
const commandCut = "…"

func shellWindowTerminalCommands(d TerminalDeps, idArg ArgSpec, quick *sync.Mutex) []Command {
	isShell := func(c Context) bool {
		return hasTerminal(c) && (d.IsShell == nil || d.IsShell(c.ActiveTerminalID))
	}
	notShell := func(c Context) string {
		if !hasTerminal(c) {
			return ""
		}
		if ids, err := terminalIDs(d.Terminal)(context.Background()); err == nil && !slices.Contains(ids, c.ActiveTerminalID) {
			return "no terminal " + c.ActiveTerminalID
		}
		return "terminal " + c.ActiveTerminalID + " is not a shell"
	}
	return []Command{
		{
			Name:  "terminal.new-free",
			Page:  PageState,
			Title: "New Terminal in Home Folder",
			Description: "Start a shell in the home folder, owned by nothing. " +
				"It belongs to no thread or project: it ends when it exits or is closed, never because a thread or project goes. " +
				"--argv runs something else; with --run, a command line is typed into it once it has printed its prompt.",
			Category:    "Terminal",
			Keybindings: []string{"cmd+shift+t"},
			Args: []ArgSpec{
				{Name: "argv", Type: String, PageAsks: true, Description: `Command line, split like a shell would (e.g. "htop -d 5")`},
				{Name: "run", Type: String, PageAsks: true, Description: "A command line typed into the new shell once it has printed its prompt, then Return"},
				terminalPaneArg,
			},
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				argv, err := a.Words("argv")
				if err != nil {
					return Result{}, err
				}
				if len(argv) == 0 {
					argv = defaultShell()
				}
				run, err := runInput(a.String("run"))
				if err != nil {
					return Result{}, err
				}
				home, err := os.UserHomeDir()
				if err != nil {
					return Result{}, fmt.Errorf("terminal.new-free: home directory: %w", err)
				}
				res, err := d.Terminal.Create(ctx, connect.NewRequest(&v1.CreateTerminalRequest{Argv: argv, Cwd: home, Labels: termlabel.Free()}))
				if err != nil {
					return Result{}, err
				}
				t := res.Msg.GetTerminal()
				msg := "created terminal " + t.GetId() + " in " + home
				tab, err := openTerminalTab(ctx, d.Layout, c, "", t.GetId(), a.String("pane"))
				if err != nil {
					return Result{}, err
				}
				msg += tab
				if run != "" {
					if err := typeRun(ctx, d, t.GetId(), run); err != nil {
						return Result{}, err
					}
					msg += " and ran the command in it"
				}
				return Result{Message: msg, JSON: t}, nil
			},
		},
		{
			Name:  "terminal.reset",
			Page:  PageState,
			Title: "Reset Terminal",
			Description: "Replace a shell with a fresh one in its owner's folder. " +
				"That is the thread's checkout, the worktree, or the home directory for a free shell; the old shell is closed. The new shell keeps the old one's labels (a quick terminal stays the " +
				"thread's quick terminal) and is labelled replaces=<old id>, so a tab showing the old one can follow it.",
			Category:       "Terminal",
			Args:           []ArgSpec{positional(idArg)},
			When:           isShell,
			WhyUnavailable: notShell,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				old, err := findShell(ctx, d.Terminal, a.String("id"), "reset")
				if err != nil {
					return Result{}, err
				}
				if err := resetAsks(ctx, uctx, old); err != nil {
					return Result{}, err
				}
				if termlabel.IsQuick(old.GetLabels()) {
					quick.Lock()
					defer quick.Unlock()
				}
				cwd, labels, err := resetPlace(ctx, d.Thread, old)
				if err != nil {
					return Result{}, err
				}
				labels[termlabel.Replaces] = old.GetId()
				res, err := d.Terminal.Create(ctx, connect.NewRequest(&v1.CreateTerminalRequest{
					Argv: old.GetArgv(), Cwd: cwd, Labels: labels, Cols: old.GetCols(), Rows: old.GetRows(),
				}))
				if err != nil {
					return Result{}, err
				}
				t := res.Msg.GetTerminal()
				if _, err := d.Terminal.Close(ctx, connect.NewRequest(&v1.CloseTerminalRequest{Id: old.GetId()})); err != nil &&
					connect.CodeOf(err) != connect.CodeNotFound {
					return Result{}, fmt.Errorf("started terminal %s in %s, but could not close %s: %w", t.GetId(), cwd, old.GetId(), err)
				}
				return Result{Message: "reset terminal " + old.GetId() + ": " + t.GetId() + " starts in " + cwd, JSON: t}, nil
			},
		},
		{
			Name:  "terminal.rerun",
			Title: "Run Last Command Again",
			Description: "Type a shell's last command into it again. " +
				"The last command is the last foreground job's command line as the process list gave it; --command types another. " +
				"It is typed once the shell has printed its prompt, then Return, and refused while something runs in it. Nothing ever reruns by itself.",
			Category: "Terminal",
			Args: []ArgSpec{
				positional(idArg),
				{Name: "command", Type: String, Description: "The command line to run instead of the last command " +
					"(a restored terminal's, which its new shell never ran)"},
			},
			When:           isShell,
			WhyUnavailable: notShell,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				t, err := findShell(ctx, d.Terminal, a.String("id"), "rerun")
				if err != nil {
					return Result{}, err
				}
				if t.GetState() == v1.TerminalState_TERMINAL_STATE_EXITED {
					return Result{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("terminal %s has exited", t.GetId()))
				}
				if fg := t.GetForeground(); fg != "" {
					return Result{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("terminal %s is running %s; run it again once that has ended", t.GetId(), fg))
				}
				line := cmp.Or(a.String("command"), t.GetLastCommand())
				switch {
				case strings.TrimSpace(line) == "":
					return Result{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("terminal %s has no last command", t.GetId()))
				case strings.HasSuffix(line, commandCut):
					return Result{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("terminal %s's last command is too long to run again", t.GetId()))
				}
				text, err := runInput(line)
				if err != nil {
					return Result{}, err
				}
				if err := typeRun(ctx, d, t.GetId(), text); err != nil {
					return Result{}, err
				}
				return Result{Message: "ran " + text + " in terminal " + t.GetId()}, nil
			},
		},
	}
}

// findShell returns terminal id (a whole id: the registry resolves a suffix first) when it
// is a shell; verb names the refusal.
func findShell(ctx context.Context, terms TerminalBackend, id, verb string) (*v1.Terminal, error) {
	res, err := terms.List(ctx, connect.NewRequest(&v1.ListTerminalsRequest{}))
	if err != nil {
		return nil, err
	}
	for _, t := range res.Msg.GetTerminals() {
		if t.GetId() != id {
			continue
		}
		if !termlabel.IsShell(t.GetLabels()) {
			return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("terminal.%s: terminal %s is not a shell", verb, id))
		}
		return t, nil
	}
	return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no terminal %s", id))
}

// resetPlace is where a reset of shell old starts and the labels it gets: a thread's
// shell in the thread's checkout now (its project and worktree as the thread has them),
// a worktree's shell in that worktree, a free shell in the home directory. The labels
// are a copy of old's (its slot kept), without replaces.
func resetPlace(ctx context.Context, threads ThreadBackend, old *v1.Terminal) (string, map[string]string, error) {
	labels := maps.Clone(old.GetLabels())
	delete(labels, termlabel.Replaces)
	switch {
	case termlabel.IsFree(labels):
		home, err := os.UserHomeDir()
		if err != nil {
			return "", nil, fmt.Errorf("terminal.reset: home directory: %w", err)
		}
		return home, labels, nil
	case labels[termlabel.Thread] != "" && threads != nil:
		res, err := threads.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: labels[termlabel.Thread]}))
		if err != nil {
			return "", nil, err
		}
		th := res.Msg.GetThread()
		if th.GetWorktreePath() == "" {
			return "", nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("thread %s has no checkout yet", th.GetId()))
		}
		labels[termlabel.Project] = th.GetProjectId()
		labels[termlabel.Worktree] = th.GetWorktreePath()
		return th.GetWorktreePath(), labels, nil
	case labels[termlabel.Worktree] != "":
		return labels[termlabel.Worktree], labels, nil
	}
	return "", nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("terminal "+old.GetId()+" has no directory to reset to"))
}

// quickTerminal returns thread's running quick terminal, or nil.
func quickTerminal(ctx context.Context, terms TerminalBackend, thread string) (*v1.Terminal, error) {
	res, err := terms.List(ctx, connect.NewRequest(&v1.ListTerminalsRequest{}))
	if err != nil {
		return nil, err
	}
	for _, t := range res.Msg.GetTerminals() {
		if termlabel.IsQuick(t.GetLabels()) && t.GetLabels()[termlabel.Thread] == thread && t.GetState() != v1.TerminalState_TERMINAL_STATE_EXITED {
			return t, nil
		}
	}
	return nil, nil
}

// resetAsks is terminal.reset's question to a page: a reset starts the old terminal's argv
// again, so a terminal started with a command line of its own (terminal.new --argv, which
// asks a page) asks again before a page's reset runs it. A plain shell's reset runs
// unasked, as a plain shell's start does.
func resetAsks(ctx context.Context, uctx Context, old *v1.Terminal) error {
	argv := old.GetArgv()
	if len(argv) == 0 || slices.Equal(argv, defaultShell()) {
		return nil
	}
	words := make([]string, len(argv))
	for i, w := range argv {
		words[i] = strconv.Quote(w)
	}
	ask := "Run this?\nterminal.reset --id " + strconv.Quote(old.GetId()) + "\nIt starts again: " + strings.Join(words, " ")
	if n := utf8.RuneCountInString(ask); n > pageAskMax && uctx.Untrusted() {
		return Failed(fmt.Errorf("terminal.reset: this call is too long to show the user (%d characters, at most %d)", n, pageAskMax))
	}
	return pageAsks(ctx, uctx, "terminal.reset", "Reset Terminal", "Allow", ask)
}
