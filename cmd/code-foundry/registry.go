package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
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
	terminal, session, repo, worktree, workspace string
}

func (cl *cli) addContextFlags(fs *flag.FlagSet) *contextFlags {
	cf := &contextFlags{}
	fs.StringVar(&cf.terminal, "context-terminal", "", "active terminal `id`")
	fs.StringVar(&cf.session, "context-session", "", "active session `id`")
	fs.StringVar(&cf.repo, "context-repo", "", "active repository `id`")
	fs.StringVar(&cf.worktree, "context-worktree", "", "active worktree `path`")
	fs.StringVar(&cf.workspace, "context-workspace", "", "active workspace `id`")
	return cf
}

func (cl *cli) uiContext(cf *contextFlags) (*v1.UiContext, error) {
	wt, err := cl.absPath(cf.worktree)
	if err != nil {
		return nil, err
	}
	return &v1.UiContext{
		ActiveTerminalId:   cf.terminal,
		ActiveSessionId:    cf.session,
		ActiveRepoId:       cf.repo,
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
	f.value, f.set = s, true
	return nil
}

// IsBoolFlag lets bool args be given as bare --force.
func (f *argFlag) IsBoolFlag() bool { return f.spec.GetType() == v1.ArgType_ARG_TYPE_BOOL }

// resolveCommand finds the command named by the longest prefix of words, joined with
// dots. It returns the command and how many words it consumed.
func resolveCommand(cmds []*v1.Command, words []string) (*v1.Command, int) {
	for n := len(words); n > 0; n-- {
		name := strings.Join(words[:n], ".")
		for _, c := range cmds {
			if c.GetName() == name {
				return c, n
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
	fs.Usage = func() { printCommandHelp(cl.stderr, cmd) }
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
	return nil
}

// invokeFailed reports a failed Invoke. Caller mistakes (bad args, unknown command,
// unavailable in this context) exit 2 with a pointer to help; anything else exits 1.
func (cl *cli) invokeFailed(name string, err error) error {
	var ce *connect.Error
	if !errors.As(err, &ce) {
		return err
	}
	msg := strings.TrimPrefix(ce.Message(), name+": ")
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
	printCommandHelp(cl.stdout, cmd)
	return nil
}

func printCommandHelp(w io.Writer, cmd *v1.Command) {
	name := cmd.GetName()
	fmt.Fprintf(w, "%s - %s\n", name, cmd.GetTitle())
	if d := cmd.GetDescription(); d != "" {
		fmt.Fprintf(w, "\n%s\n", d)
	}
	pos := positionalUsage(cmd)
	fmt.Fprintf(w, "\nUsage:\n  code-foundry %s%s [flags]\n  code-foundry %s%s [flags]\n",
		name, pos, strings.ReplaceAll(name, ".", " "), pos)

	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	if len(cmd.GetArgs()) > 0 {
		fmt.Fprintln(tw, "\nFlags:")
		for _, a := range cmd.GetArgs() {
			fmt.Fprintf(tw, "  --%s %s\t%s\n", a.GetName(), argPlaceholder(a), argDetail(a))
		}
	}
	fmt.Fprintln(tw, "\nCommon flags:")
	fmt.Fprintln(tw, "  --json\tprint the structured result as JSON")
	if cmd.GetRequiresConfirmation() {
		fmt.Fprintln(tw, "  --yes\tdo not ask for confirmation (required without a terminal)")
	}
	fmt.Fprintln(tw, "  --context-terminal id\tactive terminal, for availability and defaults")
	fmt.Fprintln(tw, "  --context-session id\tactive session")
	fmt.Fprintln(tw, "  --context-repo id\tactive repository")
	fmt.Fprintln(tw, "  --context-worktree path\tactive worktree")
	fmt.Fprintln(tw, "  --context-workspace id\tactive workspace")
	_ = tw.Flush()
	if kb := cmd.GetKeybindings(); len(kb) > 0 {
		fmt.Fprintf(w, "\nKeybindings: %s\n", strings.Join(kb, ", "))
	}
}

func argPlaceholder(a *v1.ArgSpec) string {
	switch a.GetType() {
	case v1.ArgType_ARG_TYPE_BOOL:
		return ""
	case v1.ArgType_ARG_TYPE_ENUM:
		return strings.Join(a.GetEnumValues(), "|")
	case v1.ArgType_ARG_TYPE_INT:
		return "n"
	case v1.ArgType_ARG_TYPE_PATH:
		return "path"
	default:
		return "string"
	}
}

func argDetail(a *v1.ArgSpec) string {
	d := a.GetDescription()
	if a.GetRequired() {
		d += " (required)"
	}
	if def := a.GetDefaultValue(); def != "" {
		d += fmt.Sprintf(" (default %q)", def)
	}
	return d
}
