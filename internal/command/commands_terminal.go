package command

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// TerminalBackend is the slice of TerminalService the terminal.* commands need. It is
// expressed in the generated Connect signatures because terminal.proto is the contract
// the terminal step (1a) implements: its API handler, any TerminalServiceHandler, and a
// TerminalServiceClient all satisfy it without an adapter. Until the handler is wired,
// codefoundryv1connect.UnimplementedTerminalServiceHandler stands in.
type TerminalBackend interface {
	Create(context.Context, *connect.Request[v1.CreateTerminalRequest]) (*connect.Response[v1.CreateTerminalResponse], error)
	Kill(context.Context, *connect.Request[v1.KillTerminalRequest]) (*connect.Response[v1.KillTerminalResponse], error)
	Remove(context.Context, *connect.Request[v1.RemoveTerminalRequest]) (*connect.Response[v1.RemoveTerminalResponse], error)
	Close(context.Context, *connect.Request[v1.CloseTerminalRequest]) (*connect.Response[v1.CloseTerminalResponse], error)
	List(context.Context, *connect.Request[v1.ListTerminalsRequest]) (*connect.Response[v1.ListTerminalsResponse], error)
	Write(context.Context, *connect.Request[v1.WriteTerminalRequest]) (*connect.Response[v1.WriteTerminalResponse], error)
}

var (
	_ TerminalBackend = codefoundryv1connect.TerminalServiceHandler(nil)
	_ TerminalBackend = codefoundryv1connect.TerminalServiceClient(nil)
)

// TerminalDeps are the terminal.* commands' dependencies. terminal.new reads the
// thread (Thread) or the registered worktrees (Repo) to find who owns a new shell.
type TerminalDeps struct {
	Terminal TerminalBackend
	Repo     RepoBackend
	Thread   ThreadBackend
	// IsShell reports whether terminal id is a shell terminal.new started or an action
	// run (termlabel.IsPanel). It gates terminal.close, which refuses other terminals
	// (unlabelled ones TerminalService.Create made) anyway. Nil: any terminal (the
	// refusal then comes from Close).
	IsShell func(id string) bool
	// AwaitOutput blocks until terminal id has printed its first output (a shell's
	// prompt; terminal.AwaitOutput) or ctx ends. terminal.new --run waits with it before
	// typing, so the line is not echoed ahead of the prompt. Nil: it types at once.
	AwaitOutput func(ctx context.Context, id string) error
	// BracketedPaste reports whether terminal id's line editor has turned on bracketed
	// paste (terminal.Store.BracketedPaste). When it has, terminal.new --run sends the
	// command as one paste and then Return, so tabs are not completion and a multi-line
	// block lands in the editor whole. Nil, or an error: the keys are typed one by one.
	BracketedPaste func(ctx context.Context, id string) (bool, error)
	// RunWait caps that wait (0: DefaultRunWait). When it passes, the command is typed
	// anyway: a shell that has printed nothing yet still runs it, only echoed twice.
	RunWait time.Duration
}

// DefaultRunWait is how long terminal.new --run waits for a new shell's first output
// before it types the command anyway. A login shell with heavy startup files (nvm,
// conda) can take a second or two.
const DefaultRunWait = 5 * time.Second

func hasTerminal(c Context) bool { return c.ActiveTerminalID != "" }

// canStartShell is terminal.new's availability: a thread or a worktree to own the shell
// (the GUI passes the selected one), or the CLI (ActiveView is empty only there), which
// sends its working directory as --here and is refused outside every registered project.
// The dashboard and the Pull Requests page never offer it.
func canStartShell(c Context) bool {
	return hasThread(c) || c.ActiveWorktreePath != "" || c.ActiveView == ""
}

// notInProject is how terminal.new refuses a cwd outside every registered worktree:
// "<path> is not inside a registered project" (InvalidArgument).
const notInProject = "is not inside a registered project"

// RegisterTerminal registers terminal.new, terminal.list, terminal.close, terminal.kill,
// and terminal.remove.
func RegisterTerminal(r *Registry, d TerminalDeps) error {
	idArg := ArgSpec{Name: "id", Type: String, Required: true, Context: ContextTerminal, Description: "Terminal id"}
	return r.RegisterAll(
		Command{
			Name:  "terminal.new",
			Title: "New Terminal",
			Description: "Start a shell (or argv) that belongs to the active thread, else to the active worktree, " +
				"else to the registered worktree containing --cwd (from the CLI: the working directory). " +
				"It starts in --cwd, else in the CLI's working directory when that chose the owner, else in the thread's or worktree's directory. " +
				"With --run, a command line is typed into it once it has printed its prompt (the shell stays open).",
			Category:    "Terminal",
			Keybindings: []string{"cmd+t"},
			Args: []ArgSpec{
				{Name: "cwd", Type: Path, Description: "Working directory; without a thread or worktree context, its registered worktree owns the shell"},
				{Name: "argv", Type: String, Description: `Command line, split like a shell would (e.g. "claude --model opus")`},
				{Name: "run", Type: String, Description: "A command line typed into the new shell once it has printed its prompt, then Return; " +
					"the shell stays open after it. A multi-line value is pasted whole where the shell supports bracketed paste, else typed line by line"},
				{Name: "here", Type: Path, DefaultToCwd: true, Description: "Where the CLI runs: without a thread, worktree or --cwd, " +
					"the registered worktree containing it owns the shell, which starts there (CLI default: the working directory)"},
			},
			When: canStartShell,
			WhyUnavailable: func(Context) string {
				return "a terminal belongs to a thread or a worktree: select one, or from the CLI run inside a registered project (or pass --cwd)"
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
				owner, err := shellOwner(ctx, d.Repo, d.Thread, c, a.Path("cwd"), a.Path("here"),
					"terminal.new needs a thread, a worktree, or --cwd inside a registered project")
				if err != nil {
					return Result{}, err
				}
				res, err := d.Terminal.Create(ctx, connect.NewRequest(&v1.CreateTerminalRequest{
					Argv: argv, Cwd: owner.cwd, Labels: termlabel.Shell(owner.thread, owner.repo, owner.worktree),
				}))
				if err != nil {
					return Result{}, err
				}
				t := res.Msg.GetTerminal()
				msg := "created terminal " + t.GetId()
				if run != "" {
					if err := typeRun(ctx, d, t.GetId(), run); err != nil {
						return Result{}, err
					}
					msg += " and ran the command in it"
				}
				return Result{Message: msg, JSON: t}, nil
			},
		},
		Command{
			Name:        "terminal.list",
			Title:       "List Terminals",
			Description: "List every terminal with its state, working directory and labels (who it belongs to).",
			Category:    "Terminal",
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := d.Terminal.List(ctx, connect.NewRequest(&v1.ListTerminalsRequest{}))
				if err != nil {
					return Result{}, err
				}
				var sb strings.Builder
				tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
				_, _ = fmt.Fprintln(tw, "ID\tSTATE\tCWD\tLABELS")
				for _, t := range res.Msg.GetTerminals() {
					_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", t.GetId(), terminalState(t), t.GetCwd(), formatLabels(t.GetLabels()))
				}
				_ = tw.Flush()
				return Result{Message: strings.TrimRight(sb.String(), "\n"), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:        "terminal.close",
			Title:       "Close Terminal",
			Description: "Terminate the terminal's process (SIGHUP, then SIGKILL after a grace period) and remove it once it has exited.",
			Category:    "Terminal",
			Args:        []ArgSpec{idArg},
			// Only shells and action runs: an unlabelled terminal (TerminalService.Create) is ended with
			// terminal.kill and terminal.remove. Close refuses it too.
			When: func(c Context) bool {
				return hasTerminal(c) && (d.IsShell == nil || d.IsShell(c.ActiveTerminalID))
			},
			WhyUnavailable: func(c Context) string {
				if hasTerminal(c) {
					return "terminal " + c.ActiveTerminalID + " is not a shell; use terminal.kill"
				}
				return ""
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("id")
				if _, err := d.Terminal.Close(ctx, connect.NewRequest(&v1.CloseTerminalRequest{Id: id})); err != nil {
					return Result{}, err
				}
				return Result{Message: "closed terminal " + id}, nil
			},
		},
		Command{
			Name:        "terminal.kill",
			Title:       "Kill Terminal",
			Description: "Terminate the terminal's process (SIGHUP, then SIGKILL after a grace period).",
			Category:    "Terminal",
			Args:        []ArgSpec{idArg},
			When:        hasTerminal,
			Confirm:     "Kill terminal {id}? Its process is terminated.",
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("id")
				if _, err := d.Terminal.Kill(ctx, connect.NewRequest(&v1.KillTerminalRequest{Id: id})); err != nil {
					return Result{}, err
				}
				return Result{Message: "killed terminal " + id}, nil
			},
		},
		Command{
			Name:        "terminal.remove",
			Title:       "Remove Terminal",
			Description: "Forget an exited terminal.",
			Category:    "Terminal",
			Args:        []ArgSpec{idArg},
			When:        hasTerminal,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("id")
				if _, err := d.Terminal.Remove(ctx, connect.NewRequest(&v1.RemoveTerminalRequest{Id: id})); err != nil {
					return Result{}, err
				}
				return Result{Message: "removed terminal " + id}, nil
			},
		},
	)
}

// runInput is terminal.new --run's value as the text to enter: CRLF becomes LF and
// trailing blank lines and spaces are dropped. Control characters other than tab and
// newline are refused (a code block has none, and an ESC or ^C typed into a shell does
// things; an ESC could also end a bracketed paste early). Empty or blank: nothing to type.
func runInput(s string) (string, error) {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.TrimRight(s, "\n\t ")
	if strings.TrimSpace(s) == "" {
		return "", nil
	}
	for _, r := range s {
		if (r < 0x20 && r != '\t' && r != '\n') || r == 0x7f {
			return "", InvalidArg("run", "the command has a control character (%U)", r)
		}
	}
	return s, nil
}

// Bracketed paste's start and end (mode 2004).
const (
	pasteStart = "\x1b[200~"
	pasteEnd   = "\x1b[201~"
)

// runKeys is the bytes that enter text (runInput's) into a shell. With bracketed paste
// on, one paste and Return: the line editor inserts it as is, tabs and newlines
// included, and Return runs the whole buffer. Without it, typed: each newline becomes
// Return (CR, what the Enter key sends) and one Return ends it; a tab is the Tab key
// there (completion), which only bracketed paste avoids.
func runKeys(text string, bracketed bool) []byte {
	if bracketed {
		return []byte(pasteStart + text + pasteEnd + "\r")
	}
	return []byte(strings.ReplaceAll(text, "\n", "\r") + "\r")
}

// typeRun waits (up to RunWait) for shell id's first output, then enters text into it
// (runKeys: pasted when the shell reads bracketed pastes). When the wait times out the
// text is typed anyway; any other failure of the wait (the shell exited, the caller went
// away) is an error, and the shell stays.
func typeRun(ctx context.Context, d TerminalDeps, id, text string) error {
	if d.AwaitOutput != nil {
		wait := cmp.Or(d.RunWait, DefaultRunWait)
		wctx, cancel := context.WithTimeout(ctx, wait)
		err := d.AwaitOutput(wctx, id)
		cancel()
		switch {
		case err == nil:
		case errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil:
			slog.WarnContext(ctx, "terminal.new --run: no output from the shell in time, typing anyway", "terminal", id, "wait", wait)
		default:
			return fmt.Errorf("created terminal %s, but could not run the command: %w", id, err)
		}
	}
	bracketed := false
	if d.BracketedPaste != nil {
		on, err := d.BracketedPaste(ctx, id)
		bracketed = err == nil && on
	}
	if _, err := d.Terminal.Write(ctx, connect.NewRequest(&v1.WriteTerminalRequest{Id: id, Data: runKeys(text, bracketed)})); err != nil {
		return fmt.Errorf("created terminal %s, but could not run the command: %w", id, err)
	}
	return nil
}

// terminalState is "running", or "exited <code>".
func terminalState(t *v1.Terminal) string {
	if t.GetState() == v1.TerminalState_TERMINAL_STATE_EXITED {
		return fmt.Sprintf("exited %d", t.GetExitCode())
	}
	return "running"
}

// formatLabels is "k=v" pairs sorted by key, or "-".
func formatLabels(l map[string]string) string {
	if len(l) == 0 {
		return "-"
	}
	parts := make([]string, 0, len(l))
	for _, k := range slices.Sorted(maps.Keys(l)) {
		parts = append(parts, k+"="+l[k])
	}
	return strings.Join(parts, " ")
}

// owner is who a new shell belongs to (its labels) and where it starts.
type owner struct {
	thread, repo, worktree string
	cwd                    string
}

// shellOwner decides who owns a shell terminal.new starts (and an action run action.run
// starts), in this order: the active thread; the active worktree (ActiveWorktreePath,
// matched with ActiveRepoID when given, else the registered worktree containing it); the
// registered worktree containing cwd, else here (the CLI's working directory). The shell
// starts in cwd, else in here when here chose the owner, else in the thread's worktree or
// the context's worktree path. Without any of them it fails with missing.
func shellOwner(ctx context.Context, repos RepoBackend, threads ThreadBackend, c Context, cwd, here, missing string) (owner, error) {
	if c.ActiveThreadID != "" {
		res, err := threads.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: c.ActiveThreadID}))
		if err != nil {
			return owner{}, err
		}
		s := res.Msg.GetThread()
		return owner{thread: s.GetId(), repo: s.GetRepoId(), worktree: s.GetWorktreePath(), cwd: cmp.Or(cwd, s.GetWorktreePath())}, nil
	}
	path, start := c.ActiveWorktreePath, cmp.Or(cwd, c.ActiveWorktreePath)
	if path == "" {
		path = cmp.Or(cwd, here)
		start = path
	}
	if path == "" {
		return owner{}, InvalidArg("cwd", "%s", missing)
	}
	res, err := repos.List(ctx, connect.NewRequest(&v1.ListReposRequest{}))
	if err != nil {
		return owner{}, err
	}
	repoID, wt, ok := ownerWorktree(res.Msg.GetRepos(), c.ActiveRepoID, c.ActiveWorktreePath, realPath(path))
	if !ok {
		return owner{}, InvalidArg("cwd", "%s %s", path, notInProject)
	}
	return owner{repo: repoID, worktree: wt, cwd: start}, nil
}

// ownerWorktree returns the registered worktree at wtPath (in repo repoID when that is
// given), else the deepest registered worktree containing path.
func ownerWorktree(repos []*v1.Repo, repoID, wtPath, path string) (string, string, bool) {
	var bestRepo, best string
	for _, r := range repos {
		for _, w := range r.GetWorktrees() {
			if wtPath != "" && w.GetPath() == wtPath && (repoID == "" || r.GetId() == repoID) {
				return r.GetId(), w.GetPath(), true
			}
			if path != "" && within(path, w.GetPath()) && len(w.GetPath()) > len(best) {
				bestRepo, best = r.GetId(), w.GetPath()
			}
		}
	}
	return bestRepo, best, best != ""
}

// foldCase is whether paths compare case-insensitively: macOS volumes (APFS, HFS+) are
// case-insensitive by default, and EvalSymlinks keeps the case it was given.
var foldCase = runtime.GOOS == "darwin"

// within reports whether path is root or inside it. Both are absolute and clean.
func within(path, root string) bool {
	if root == "" {
		return false
	}
	if foldCase {
		path, root = strings.ToLower(path), strings.ToLower(root)
	}
	return path == root || strings.HasPrefix(path, strings.TrimSuffix(root, "/")+"/")
}

// realPath resolves symlinks in p the way the repo store stores paths (/tmp is
// /private/tmp on macOS). A path that does not exist (yet) is resolved through its
// nearest existing ancestor, with the missing rest appended.
func realPath(p string) string {
	if p == "" {
		return ""
	}
	p = filepath.Clean(p)
	var rest []string
	for dir := p; ; dir = filepath.Dir(dir) {
		if r, err := filepath.EvalSymlinks(dir); err == nil {
			return filepath.Join(append([]string{r}, rest...)...)
		}
		if parent := filepath.Dir(dir); parent == dir {
			return p
		}
		rest = append([]string{filepath.Base(dir)}, rest...)
	}
}

// defaultShell is the user's login shell, as a terminal emulator would start it.
func defaultShell() []string {
	sh := os.Getenv("SHELL")
	if sh == "" {
		sh = "/bin/zsh"
	}
	return []string{sh, "-l"}
}
