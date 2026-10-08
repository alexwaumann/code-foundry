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
	"syscall"
)

// subcommand is one CLI verb. Infrastructure verbs live here; user actions will come from
// the command registry (internal/command) once it lands.
type subcommand struct {
	name    string
	summary string
	run     func(ctx context.Context, args []string) error
}

var subcommands = []subcommand{
	{"daemon", "Run the daemon in the foreground (--dev for text logs on stderr)", runDaemon},
	{"status", "Show daemon status, starting it if needed", runStatus},
	{"version", "Print version information", runVersion},
}

// errUsage marks errors already explained to the user; main exits 2 without repeating them.
var errUsage = errors.New("usage")

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := dispatch(ctx, os.Args[1:], os.Stdout, os.Stderr)
	stop()
	switch {
	case err == nil:
	case errors.Is(err, errUsage):
		os.Exit(2)
	default:
		fmt.Fprintln(os.Stderr, "code-foundry:", err)
		os.Exit(1)
	}
}

func dispatch(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		fmt.Fprintln(stdout, "code-foundry: the GUI is launched with `code-foundry gui` (not wired up yet).")
		fmt.Fprintln(stdout, "Run `code-foundry help` for available commands.")
		return nil
	}
	name, rest := args[0], args[1:]
	switch name {
	case "help", "-h", "-help", "--help":
		usage(stdout)
		return nil
	}
	for _, c := range subcommands {
		if c.name == name {
			return c.run(ctx, rest)
		}
	}
	fmt.Fprintf(stderr, "code-foundry: unknown command %q\n\n", name)
	usage(stderr)
	return errUsage
}

func usage(w io.Writer) {
	fmt.Fprintln(w, "Usage: code-foundry <command> [flags]")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Commands:")
	for _, c := range subcommands {
		fmt.Fprintf(w, "  %-10s %s\n", c.name, c.summary)
	}
}

// newFlagSet returns a FlagSet that reports parse errors as errUsage.
func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet("code-foundry "+name, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	return fs
}

func parseFlags(fs *flag.FlagSet, args []string) error {
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return errUsage
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "%s: unexpected arguments %v\n", fs.Name(), fs.Args())
		return errUsage
	}
	return nil
}
