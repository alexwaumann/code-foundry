// Command code-foundry is the single binary for the daemon, the CLI verbs, and (later)
// the GUI launcher.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/paths"
)

// subcommand is a local infrastructure verb. Every user action is a daemon command
// (internal/command) and reaches the CLI through runRegistry, never through this table.
type subcommand struct {
	name    string
	summary string
	run     func(ctx context.Context, cl *cli, args []string) error
}

var subcommands = []subcommand{
	{"daemon", "Run the daemon in the foreground (--dev for text logs on stderr)", runDaemon},
	{"status", "Show daemon status, starting it if needed", runStatus},
	{"version", "Print version information", runVersion},
	{"commands", "List daemon commands and their availability (--context-* flags)", runCommands},
	{"gui", "Start the app (the GUI installed next to this CLI, or the dev build)", runGUI},
	{"update", "Install the latest release (also --update; --version, --force, --yes)", runUpdate},
}

// errUsage marks errors already explained to the user; main exits 2 without repeating them.
var errUsage = errors.New("usage")

// cli carries the dispatcher's I/O and daemon connection so tests can swap them.
type cli struct {
	stdout, stderr io.Writer
	// connect returns a client for the daemon, starting it if needed.
	connect func(context.Context) (*client.Client, error)
	// getwd resolves relative path flags.
	getwd func() (string, error)
	// stdin and interactive serve confirmation prompts; without them (or when
	// interactive reports false) destructive commands need --yes.
	stdin       io.Reader
	interactive func() bool
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	cl := &cli{stdout: os.Stdout, stderr: os.Stderr, connect: connectDaemon, getwd: os.Getwd, stdin: os.Stdin, interactive: stdinIsTerminal}
	err := cl.dispatch(ctx, os.Args[1:])
	stop()
	switch {
	case err == nil:
	case errors.Is(err, errUsage):
		os.Exit(2)
	case errors.Is(err, errCancelled):
		os.Exit(1)
	default:
		fmt.Fprintln(os.Stderr, "code-foundry:", err)
		os.Exit(1)
	}
}

func connectDaemon(ctx context.Context) (*client.Client, error) {
	p, err := paths.Resolve()
	if err != nil {
		return nil, err
	}
	opts, err := connectOptions(os.Getenv)
	if err != nil {
		return nil, err
	}
	return client.Connect(ctx, p, opts)
}

// connectOptions prefers the loopback endpoint a session's environment names
// (client.EnvEndpoint, client.EnvToken) over the Unix socket. Sandboxed sessions
// cannot reach Unix sockets, and Connect never auto-starts a daemon for an endpoint.
func connectOptions(getenv func(string) string) (client.ConnectOptions, error) {
	ep, ok, err := client.EndpointFromEnv(getenv)
	if err != nil || !ok {
		return client.ConnectOptions{}, err
	}
	return client.ConnectOptions{Endpoint: &ep}, nil
}

// dispatch runs a local verb, or else a daemon command. A local verb followed by a bare
// word ("daemon status") is a daemon command name, not the verb with an argument.
func (cl *cli) dispatch(ctx context.Context, args []string) error {
	if len(args) == 0 {
		fmt.Fprintln(cl.stdout, "code-foundry: open the app with `code-foundry gui`.")
		fmt.Fprintln(cl.stdout, "Run `code-foundry help` for available commands.")
		return nil
	}
	name, rest := args[0], args[1:]
	switch name {
	case "help", "-h", "-help", "--help":
		return cl.help(ctx, rest)
	case "--update":
		return runUpdate(ctx, cl, rest)
	}
	if sc, ok := localVerb(name); ok && (len(rest) == 0 || !isWord(rest[0])) {
		return sc.run(ctx, cl, rest)
	}
	if !isWord(name) {
		fmt.Fprintf(cl.stderr, "code-foundry: unknown flag %q\n\n", name)
		cl.usage(cl.stderr)
		return errUsage
	}
	return cl.runRegistry(ctx, args)
}

func localVerb(name string) (subcommand, bool) {
	for _, c := range subcommands {
		if c.name == name {
			return c, true
		}
	}
	return subcommand{}, false
}

// isWord reports whether s is a positional token rather than a flag.
func isWord(s string) bool { return s != "" && !strings.HasPrefix(s, "-") }

// help prints general usage, a local verb's summary, or a daemon command's help.
func (cl *cli) help(ctx context.Context, args []string) error {
	if len(args) == 0 {
		cl.usage(cl.stdout)
		return nil
	}
	if sc, ok := localVerb(args[0]); ok && len(args) == 1 {
		fmt.Fprintf(cl.stdout, "code-foundry %s: %s\n", sc.name, sc.summary)
		return nil
	}
	return cl.commandHelp(ctx, args)
}

func (cl *cli) usage(w io.Writer) {
	fmt.Fprintln(w, "Usage: code-foundry <command> [flags]")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Built-in commands:")
	for _, c := range subcommands {
		fmt.Fprintf(w, "  %-10s %s\n", c.name, c.summary)
	}
	fmt.Fprintf(w, "  %-10s %s\n", "help", "Show this help, or `help <command>` for one command")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Daemon commands come from the daemon's command registry. Run `code-foundry commands`")
	fmt.Fprintln(w, "to list them. Invoke one by its dotted name or with spaces:")
	fmt.Fprintln(w, "  code-foundry terminal.new --cwd .")
	fmt.Fprintln(w, "  code-foundry terminal new --cwd .")
	fmt.Fprintln(w, "  code-foundry settings set appearance.font_size 14")
}

// newFlagSet returns a FlagSet that reports parse errors as errUsage.
func (cl *cli) newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet("code-foundry "+name, flag.ContinueOnError)
	fs.SetOutput(cl.stderr)
	return fs
}

// parseFlags parses args into fs. It returns errHelp for -h, errUsage on bad flags or
// stray positional arguments.
func (cl *cli) parseFlags(fs *flag.FlagSet, args []string) error {
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return errHelp
		}
		return errUsage
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(cl.stderr, "%s: unexpected arguments %v\n", fs.Name(), fs.Args())
		return errUsage
	}
	return nil
}

// errHelp means -h was given and usage was printed; callers return nil.
var errHelp = errors.New("help requested")
