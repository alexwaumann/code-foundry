package command

import (
	"context"
	"fmt"
	"os"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
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
}

var (
	_ TerminalBackend = codefoundryv1connect.TerminalServiceHandler(nil)
	_ TerminalBackend = codefoundryv1connect.TerminalServiceClient(nil)
)

func hasTerminal(c Context) bool { return c.ActiveTerminalID != "" }

// RegisterTerminal registers terminal.new, terminal.kill, and terminal.remove.
func RegisterTerminal(r *Registry, b TerminalBackend) error {
	idArg := ArgSpec{Name: "id", Type: String, Required: true, Context: ContextTerminal, Description: "Terminal id"}
	return r.RegisterAll(
		Command{
			Name:        "terminal.new",
			Title:       "New Terminal",
			Description: "Start a terminal running argv (default: your login shell) in cwd (default: the active worktree, else your home directory).",
			Category:    "Terminal",
			Keybindings: []string{"cmd+t"},
			Args: []ArgSpec{
				{Name: "cwd", Type: Path, Context: ContextWorktree, Description: "Working directory"},
				{Name: "argv", Type: String, Description: `Command line, split like a shell would (e.g. "claude --model opus")`},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				argv, err := a.Words("argv")
				if err != nil {
					return Result{}, err
				}
				if len(argv) == 0 {
					argv = defaultShell()
				}
				cwd := a.Path("cwd")
				if cwd == "" {
					if cwd, err = os.UserHomeDir(); err != nil {
						return Result{}, fmt.Errorf("terminal.new: default cwd: %w", err)
					}
				}
				res, err := b.Create(ctx, connect.NewRequest(&v1.CreateTerminalRequest{Argv: argv, Cwd: cwd}))
				if err != nil {
					return Result{}, err
				}
				t := res.Msg.GetTerminal()
				return Result{Message: "created terminal " + t.GetId(), JSON: t}, nil
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
				if _, err := b.Kill(ctx, connect.NewRequest(&v1.KillTerminalRequest{Id: id})); err != nil {
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
				if _, err := b.Remove(ctx, connect.NewRequest(&v1.RemoveTerminalRequest{Id: id})); err != nil {
					return Result{}, err
				}
				return Result{Message: "removed terminal " + id}, nil
			},
		},
	)
}

// defaultShell is the user's login shell, as a terminal emulator would start it.
func defaultShell() []string {
	sh := os.Getenv("SHELL")
	if sh == "" {
		sh = "/bin/zsh"
	}
	return []string{sh, "-l"}
}
