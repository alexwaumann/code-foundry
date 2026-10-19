package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"maps"
	"os"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// errCancelled means the user answered no to a confirmation prompt (exit 1).
var errCancelled = errors.New("cancelled")

// stdinIsTerminal reports whether stdin and stderr are terminals, so a prompt can be
// shown and answered.
func stdinIsTerminal() bool {
	for _, f := range []*os.File{os.Stdin, os.Stderr} {
		fi, err := f.Stat()
		if err != nil || fi.Mode()&os.ModeCharDevice == 0 {
			return false
		}
	}
	return true
}

// confirmationOf returns the ConfirmationRequired detail of an Invoke error, or nil.
func confirmationOf(err error) *v1.ConfirmationRequired {
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeFailedPrecondition {
		return nil
	}
	for _, d := range ce.Details() {
		if m, derr := d.Value(); derr == nil {
			if cr, ok := m.(*v1.ConfirmationRequired); ok {
				return cr
			}
		}
	}
	return nil
}

// maxConfirmStages bounds how many confirmations one invoke asks (the command's own,
// then a second stage such as deleting uncommitted work).
const maxConfirmStages = 3

// invoke calls the command, asking for confirmation when the daemon requires it: on a
// terminal the user is prompted and the command re-invoked with confirmed set (and a
// second-stage confirmation's args merged in); otherwise the message is printed with a
// pointer to --yes (exit 2). --yes never answers a second-stage confirmation (one with
// args, e.g. deleting uncommitted work): the command's declined result stands when it
// has one, else it fails pointing at the flag (--force) to pass on purpose.
func (cl *cli) invoke(ctx context.Context, cmd *v1.Command, uctx *v1.UiContext, vals map[string]string, yes bool) (*v1.InvokeCommandResponse, error) {
	c, err := cl.connect(ctx)
	if err != nil {
		return nil, err
	}
	name := cmd.GetName()
	req := &v1.InvokeCommandRequest{Name: name, Context: uctx, Args: vals, Confirmed: yes}
	var stdin *bufio.Reader
	for stage := 0; ; stage++ {
		res, err := c.Command.Invoke(ctx, connect.NewRequest(req))
		if err == nil {
			return res.Msg, nil
		}
		cr := confirmationOf(err)
		if cr == nil || stage >= maxConfirmStages {
			return nil, cl.invokeFailed(name, err)
		}
		escalates := len(cr.GetArgs()) > 0
		if escalates && cr.GetCommand() != name {
			// A command run for this one (plugin.act's button) asks again: its args are
			// not this command's to merge.
			fmt.Fprintf(cl.stderr, "code-foundry %s: %s\nRun %s itself to answer this.\n", name, cr.GetMessage(), cr.GetCommand())
			return nil, errUsage
		}
		if escalates && yes {
			return cl.notAnsweredByYes(name, cr)
		}
		if cl.interactive == nil || !cl.interactive() || cl.stdin == nil {
			if escalates {
				return cl.notAnsweredByYes(name, cr)
			}
			fmt.Fprintf(cl.stderr, "code-foundry %s: %s\nRe-run with --yes to confirm.\n", name, cr.GetMessage())
			return nil, errUsage
		}
		fmt.Fprintf(cl.stderr, "%s [y/N] ", cr.GetMessage())
		if stdin == nil {
			stdin = bufio.NewReader(cl.stdin)
		}
		answer, _ := stdin.ReadString('\n')
		if a := strings.ToLower(strings.TrimSpace(answer)); a != "y" && a != "yes" {
			if d := cr.GetDeclined(); d != nil {
				return d, nil
			}
			fmt.Fprintf(cl.stderr, "code-foundry %s: cancelled\n", name)
			return nil, errCancelled
		}
		req.Confirmed = true
		if escalates {
			merged := maps.Clone(req.Args)
			if merged == nil {
				merged = map[string]string{}
			}
			maps.Copy(merged, cr.GetArgs())
			req.Args = merged
		}
	}
}

// notAnsweredByYes handles a second-stage confirmation the user was not asked (--yes,
// or no terminal): the declined result when the command has one, with a note on
// stderr, else the message and the flags that answer it (exit 2).
func (cl *cli) notAnsweredByYes(name string, cr *v1.ConfirmationRequired) (*v1.InvokeCommandResponse, error) {
	flags := argFlags(cr.GetArgs())
	if d := cr.GetDeclined(); d != nil {
		fmt.Fprintf(cl.stderr, "code-foundry %s: this was not asked, so nothing more was done (--yes does not answer it; %s does):\n%s\n",
			name, flags, cr.GetMessage())
		return d, nil
	}
	fmt.Fprintf(cl.stderr, "code-foundry %s: %s\n--yes does not answer this; re-run with %s to.\n", name, cr.GetMessage(), flags)
	return nil, errUsage
}

// argFlags renders args as the CLI flags that pass them: "--force", "--mode=x".
func argFlags(args map[string]string) string {
	out := make([]string, 0, len(args))
	for _, k := range slices.Sorted(maps.Keys(args)) {
		if v := args[k]; v == "true" {
			out = append(out, "--"+k)
		} else {
			out = append(out, "--"+k+"="+v)
		}
	}
	return strings.Join(out, " ")
}

// parseWithPositionals parses flags that may be interleaved with bare words
// (`settings set --json key value`) and returns the words. "--" ends flags. A negative
// number ("-1", "-0.5") or a dash word with a space in it ("--json now prints JSON", a
// report's summary) is a word, not a flag, unless it is the value of the flag before it
// (`thread budget -1`, `--usd -1`).
func (cl *cli) parseWithPositionals(fs *flag.FlagSet, args []string) ([]string, error) {
	var words []string
	for {
		if i := dashWord(fs, args); i >= 0 {
			head, err := cl.parseWithPositionals(fs, args[:i])
			if err != nil {
				return nil, err
			}
			words = append(append(words, head...), args[i])
			args = args[i+1:]
			continue
		}
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil, errHelp
			}
			return nil, errUsage
		}
		rest := fs.Args()
		if n := len(args) - len(rest); n > 0 && args[n-1] == "--" {
			// The flag package ate the "--" that ended its flags: the rest are words.
			return append(words, rest...), nil
		}
		args = rest
		if len(args) == 0 {
			return words, nil
		}
		if args[0] == "--" {
			return append(words, args[1:]...), nil
		}
		words, args = append(words, args[0]), args[1:]
	}
}

// dashWord is the index of the first word in args the flag package would take for a
// flag, or -1: a negative number, or a dash word whose name has a space in it (no flag's
// does). It stops at "--"; a word right after a flag that takes a value (--usd -1) is
// that flag's.
func dashWord(fs *flag.FlagSet, args []string) int {
	for i, a := range args {
		if a == "--" {
			return -1
		}
		if (!negativeNumber.MatchString(a) && !spacedDash(a)) || (i > 0 && takesValue(fs, args[i-1])) {
			continue
		}
		return i
	}
	return -1
}

// spacedDash: a starts with "-" and its name (before any "=value") has white space, so
// it is text ("--json now prints JSON"), not a flag.
func spacedDash(a string) bool {
	if !strings.HasPrefix(a, "-") {
		return false
	}
	name, _, _ := strings.Cut(strings.TrimLeft(a, "-"), "=")
	return strings.ContainsFunc(name, unicode.IsSpace)
}

var negativeNumber = regexp.MustCompile(`^-[0-9]+(\.[0-9]*)?$|^-\.[0-9]+$`)

// takesValue: tok is a defined flag without "=value" whose value is the next arg (not a
// bool flag).
func takesValue(fs *flag.FlagSet, tok string) bool {
	if !strings.HasPrefix(tok, "-") || strings.Contains(tok, "=") || negativeNumber.MatchString(tok) {
		return false
	}
	f := fs.Lookup(strings.TrimLeft(tok, "-"))
	if f == nil {
		return false
	}
	b, ok := f.Value.(interface{ IsBoolFlag() bool })
	return !ok || !b.IsBoolFlag()
}

// assignPositionals gives each word to the next positional arg not already set by its
// flag, in declaration order.
func (cl *cli) assignPositionals(fs *flag.FlagSet, flags []*argFlag, words []string) error {
	for _, f := range flags {
		if len(words) == 0 {
			return nil
		}
		if f.spec.GetPositional() && !f.set {
			_ = f.Set(words[0])
			words = words[1:]
		}
	}
	if len(words) > 0 {
		fmt.Fprintf(cl.stderr, "%s: unexpected arguments %v\n", fs.Name(), words)
		return errUsage
	}
	return nil
}
