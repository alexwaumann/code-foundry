package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
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

// invoke calls the command, asking for confirmation when the daemon requires it: on a
// terminal the user is prompted and the command re-invoked with confirmed set;
// otherwise the message is printed with a pointer to --yes (exit 2).
func (cl *cli) invoke(ctx context.Context, cmd *v1.Command, uctx *v1.UiContext, vals map[string]string, yes bool) (*v1.InvokeCommandResponse, error) {
	c, err := cl.connect(ctx)
	if err != nil {
		return nil, err
	}
	name := cmd.GetName()
	req := &v1.InvokeCommandRequest{Name: name, Context: uctx, Args: vals, Confirmed: yes}
	res, err := c.Command.Invoke(ctx, connect.NewRequest(req))
	if err == nil {
		return res.Msg, nil
	}
	cr := confirmationOf(err)
	if cr == nil {
		return nil, cl.invokeFailed(name, err)
	}
	if cl.interactive == nil || !cl.interactive() || cl.stdin == nil {
		fmt.Fprintf(cl.stderr, "code-foundry %s: %s\nRe-run with --yes to confirm.\n", name, cr.GetMessage())
		return nil, errUsage
	}
	fmt.Fprintf(cl.stderr, "%s [y/N] ", cr.GetMessage())
	answer, _ := bufio.NewReader(cl.stdin).ReadString('\n')
	if a := strings.ToLower(strings.TrimSpace(answer)); a != "y" && a != "yes" {
		fmt.Fprintf(cl.stderr, "code-foundry %s: cancelled\n", name)
		return nil, errCancelled
	}
	req.Confirmed = true
	res, err = c.Command.Invoke(ctx, connect.NewRequest(req))
	if err != nil {
		return nil, cl.invokeFailed(name, err)
	}
	return res.Msg, nil
}

// parseWithPositionals parses flags that may be interleaved with bare words
// (`settings set --json key value`) and returns the words. "--" ends flags.
func (cl *cli) parseWithPositionals(fs *flag.FlagSet, args []string) ([]string, error) {
	var words []string
	for {
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil, errHelp
			}
			return nil, errUsage
		}
		args = fs.Args()
		if len(args) == 0 {
			return words, nil
		}
		if args[0] == "--" {
			return append(words, args[1:]...), nil
		}
		words, args = append(words, args[0]), args[1:]
	}
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

// positionalUsage is " <key> [<value>]" for a command's positional args.
func positionalUsage(cmd *v1.Command) string {
	var sb strings.Builder
	for _, a := range cmd.GetArgs() {
		if !a.GetPositional() {
			continue
		}
		if a.GetRequired() {
			fmt.Fprintf(&sb, " <%s>", a.GetName())
		} else {
			fmt.Fprintf(&sb, " [<%s>]", a.GetName())
		}
	}
	return sb.String()
}
