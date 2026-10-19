package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/guide"
	"github.com/alexwaumann/code-foundry/internal/paths"
)

// User-facing verbs are generated at runtime from the daemon's CommandService.List, so
// a new command never needs a CLI edit. A command is invoked by its dotted name
// ("terminal.new") or by the same segments as separate words ("terminal new"). Its
// ArgSpecs become flags; every generated verb also has --json and --context-* flags.

// quietHelp turns errHelp (usage already printed for -h) into success.
func quietHelp(err error) error {
	if errors.Is(err, errHelp) {
		return nil
	}
	return err
}

// contextFlags are the --context-* flags that set UiContext for availability checks
// and context-defaulted args.
type contextFlags struct {
	terminal, thread, project, worktree, workspace string
}

// addContextFlags adds the --context-* flags. --context-thread defaults to
// $CODE_FOUNDRY_THREAD, which the daemon sets in every thread's Claude process, so a
// thread's agent running `code-foundry terminal new` or `action run` acts for its own
// thread (its bottom panel). --context-thread= (empty) opts out.
func (cl *cli) addContextFlags(fs *flag.FlagSet) *contextFlags {
	cf := &contextFlags{}
	fs.StringVar(&cf.terminal, "context-terminal", "", "active terminal `id`")
	fs.StringVar(&cf.thread, "context-thread", cl.threadEnv(), "active thread `id` (default $"+paths.EnvThread+")")
	fs.StringVar(&cf.project, "context-project", "", "active project `id`")
	fs.StringVar(&cf.worktree, "context-worktree", "", "active worktree `path`")
	fs.StringVar(&cf.workspace, "context-workspace", "", "active workspace `id`")
	return cf
}

// env reads an environment variable through cl.getenv; "" without one.
func (cl *cli) env(key string) string {
	if cl.getenv == nil {
		return ""
	}
	return strings.TrimSpace(cl.getenv(key))
}

// threadEnv is --context-thread's default: $CODE_FOUNDRY_THREAD, else, for one release,
// its old name $CODE_FOUNDRY_SESSION (paths.EnvThreadLegacy).
func (cl *cli) threadEnv() string {
	if id := cl.env(paths.EnvThread); id != "" {
		return id
	}
	return cl.env(paths.EnvThreadLegacy)
}

func (cl *cli) uiContext(cf *contextFlags) (*v1.UiContext, error) {
	wt, err := cl.absPath(cf.worktree)
	if err != nil {
		return nil, err
	}
	return &v1.UiContext{
		ActiveTerminalId:   cf.terminal,
		ActiveThreadId:     cf.thread,
		ActiveProjectId:    cf.project,
		ActiveWorktreePath: wt,
		ActiveWorkspaceId:  cf.workspace,
	}, nil
}

// absPath makes a relative path absolute against the CLI's cwd; the daemon's cwd is /.
// Empty and ~-prefixed paths are passed through (the daemon expands ~).
func (cl *cli) absPath(p string) (string, error) {
	if p == "" || filepath.IsAbs(p) || strings.HasPrefix(p, "~") {
		return p, nil
	}
	wd, err := cl.getwd()
	if err != nil {
		return "", fmt.Errorf("resolve %q: %w", p, err)
	}
	return filepath.Join(wd, p), nil
}

// argFlag is a flag.Value for one ArgSpec that remembers whether it was set, so unset
// flags are omitted and the daemon applies defaults.
type argFlag struct {
	spec  *v1.ArgSpec
	value string
	set   bool
}

func (f *argFlag) String() string { return f.value }

func (f *argFlag) Set(s string) error {
	if f.set && f.spec.GetRepeatable() {
		// A repeatable flag's values travel joined by newlines (thread subscribe --arg).
		f.value += "\n" + s
		return nil
	}
	f.value, f.set = s, true
	return nil
}

// IsBoolFlag lets bool args be given as bare --force.
func (f *argFlag) IsBoolFlag() bool { return f.spec.GetType() == v1.ArgType_ARG_TYPE_BOOL }

// resolveCommand finds the command named by the longest prefix of words, joined with
// dots. It returns the command and how many words it consumed. When no prefix names a
// command, a prefix naming a domain with a "show" command runs that: `code-foundry
// usage` is usage.show (command names have at least two segments).
func resolveCommand(cmds []*v1.Command, words []string) (*v1.Command, int) {
	for _, suffix := range []string{"", ".show"} {
		for n := len(words); n > 0; n-- {
			name := strings.Join(words[:n], ".") + suffix
			for _, c := range cmds {
				if c.GetName() == name {
					return c, n
				}
			}
		}
	}
	return nil, 0
}

// leadingWords returns the positional tokens before the first flag.
func leadingWords(args []string) []string {
	for i, a := range args {
		if !isWord(a) {
			return args[:i]
		}
	}
	return args
}

// lookup connects to the daemon and resolves args to a command.
func (cl *cli) lookup(ctx context.Context, args []string) (*v1.Command, []string, error) {
	c, err := cl.connect(ctx)
	if err != nil {
		return nil, nil, err
	}
	cmds, err := c.ListCommands(ctx, nil, true)
	if err != nil {
		return nil, nil, err
	}
	words := leadingWords(args)
	cmd, n := resolveCommand(cmds, words)
	if cmd == nil {
		fmt.Fprintf(cl.stderr, "code-foundry: unknown command %q (run `code-foundry commands` to list commands)\n",
			strings.Join(words, " "))
		return nil, nil, errUsage
	}
	return cmd, args[n:], nil
}

// runRegistry invokes a daemon command.
func (cl *cli) runRegistry(ctx context.Context, args []string) error {
	cmd, rest, err := cl.lookup(ctx, args)
	if err != nil {
		return err
	}
	fs := cl.newFlagSet(cmd.GetName())
	fs.Usage = func() { guide.WriteHelp(cl.stderr, cmd, true) }
	flags := make([]*argFlag, len(cmd.GetArgs()))
	for i, a := range cmd.GetArgs() {
		flags[i] = &argFlag{spec: a}
		fs.Var(flags[i], a.GetName(), a.GetDescription())
	}
	asJSON := fs.Bool("json", false, "print the structured result as JSON")
	yes := new(bool)
	if cmd.GetRequiresConfirmation() {
		fs.BoolVar(yes, "yes", false, "do not ask for confirmation")
	}
	cf := cl.addContextFlags(fs)
	words, err := cl.parseWithPositionals(fs, rest)
	if err != nil {
		return quietHelp(err)
	}
	if err := cl.assignPositionals(fs, flags, words); err != nil {
		return err
	}

	uctx, err := cl.uiContext(cf)
	if err != nil {
		return err
	}
	vals := make(map[string]string, len(flags))
	for _, f := range flags {
		if !f.set && f.spec.GetDefaultToCwd() {
			wd, err := cl.getwd()
			if err != nil {
				return fmt.Errorf("--%s defaults to the working directory: %w", f.spec.GetName(), err)
			}
			f.value, f.set = wd, true
		}
		if !f.set && f.spec.GetDefaultToThreadEnv() {
			// --flag= (set, empty) opts out.
			if id := cl.threadEnv(); id != "" {
				f.value, f.set = id, true
			}
		}
		if f.set && f.spec.GetFileOrStdin() {
			v, err := cl.readArgSource(f.spec.GetName(), f.value)
			if err != nil {
				return err
			}
			f.value = v
		}
	}
	for _, f := range flags {
		if !f.set {
			continue
		}
		v := f.value
		if f.spec.GetType() == v1.ArgType_ARG_TYPE_PATH {
			if v, err = cl.absPath(v); err != nil {
				return err
			}
		}
		vals[f.spec.GetName()] = v
	}

	if present, ok := cliPresenters[cmd.GetName()]; ok {
		c, err := cl.connect(ctx)
		if err != nil {
			return err
		}
		return present(ctx, cl, c, vals, *asJSON)
	}
	res, err := cl.invoke(ctx, cmd, uctx, vals, *yes)
	if err != nil {
		return err
	}
	switch {
	case *asJSON && res.GetResultJson() != "":
		fmt.Fprintln(cl.stdout, res.GetResultJson())
	case *asJSON:
		fmt.Fprintln(cl.stdout, "null")
	case res.GetMessage() != "":
		fmt.Fprintln(cl.stdout, res.GetMessage())
	}
	if code := res.GetExitCode(); code != 0 {
		return exitCodeError(code)
	}
	if f, ok := cliFollowers[cmd.GetName()]; ok && !*asJSON && cl.wantsFollow(f, flags) {
		if name, lines, ok := f.target(vals, res); ok {
			c, err := cl.connect(ctx)
			if err != nil {
				return err
			}
			if f.follow != nil {
				return f.follow(ctx, cl, c, res)
			}
			return cl.followPluginLog(ctx, c, name, lines)
		}
	}
	return nil
}

// invokeFailed reports a failed Invoke. Caller mistakes (bad args, unknown command,
// unavailable in this context) exit 2 with a pointer to help; a command's own failure
// (CommandFailed: a plugin's error, its plugin down) prints its message and exits 1, as
// does anything else.
func (cl *cli) invokeFailed(name string, err error) error {
	var ce *connect.Error
	if !errors.As(err, &ce) {
		return err
	}
	msg := strings.TrimPrefix(ce.Message(), name+": ")
	if commandFailed(ce) {
		// The command's own failure (a plugin's error, its plugin down): its words, exit 1.
		fmt.Fprintf(cl.stderr, "code-foundry %s: %s\n", name, msg)
		return errReported
	}
	switch ce.Code() {
	case connect.CodeInvalidArgument, connect.CodeNotFound, connect.CodeFailedPrecondition:
		fmt.Fprintf(cl.stderr, "code-foundry %s: %s\n", name, msg)
		fmt.Fprintf(cl.stderr, "Run `code-foundry help %s` for usage.\n", name)
		return errUsage
	case connect.CodeUnknown:
		// The tool's own words (several lines from gh repo clone or create): as is.
		if strings.Contains(msg, "\n") {
			fmt.Fprintf(cl.stderr, "code-foundry %s failed:\n%s\n", name, msg)
			return errReported
		}
	}
	return fmt.Errorf("%s: %s (%s)", name, msg, ce.Code())
}

// commandFailed reports whether ce carries a CommandFailed detail: the command could not
// do what it was asked on its own terms, not because of how it was called.
func commandFailed(ce *connect.Error) bool {
	for _, d := range ce.Details() {
		if m, err := d.Value(); err == nil {
			if _, ok := m.(*v1.CommandFailed); ok {
				return true
			}
		}
	}
	return false
}

// errReported marks a failure already printed in full (exit 1).
var errReported = errors.New("reported")

// runCommands lists every daemon command with its availability in the given context.
func runCommands(ctx context.Context, cl *cli, args []string) error {
	fs := cl.newFlagSet("commands")
	cf := cl.addContextFlags(fs)
	if err := cl.parseFlags(fs, args); err != nil {
		return quietHelp(err)
	}
	uctx, err := cl.uiContext(cf)
	if err != nil {
		return err
	}
	c, err := cl.connect(ctx)
	if err != nil {
		return err
	}
	cmds, err := c.ListCommands(ctx, uctx, true)
	if err != nil {
		return err
	}
	w := tabwriter.NewWriter(cl.stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "CATEGORY\tNAME\tAVAILABLE\tTITLE")
	for _, cmd := range cmds {
		avail := "no"
		if cmd.GetAvailable() {
			avail = "yes"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", cmd.GetCategory(), cmd.GetName(), avail, cmd.GetTitle())
	}
	return w.Flush()
}

// commandHelp prints help for the daemon command named by words.
func (cl *cli) commandHelp(ctx context.Context, words []string) error {
	cmd, rest, err := cl.lookup(ctx, words)
	if err != nil {
		return err
	}
	if len(rest) > 0 {
		fmt.Fprintf(cl.stderr, "code-foundry help: unexpected arguments %v\n", rest)
		return errUsage
	}
	guide.WriteHelp(cl.stdout, cmd, true)
	return nil
}
