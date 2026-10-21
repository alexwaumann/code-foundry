package guide

import (
	"fmt"
	"io"
	"strings"
	"text/tabwriter"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/paths"
)

// WriteHelp writes a command's `code-foundry help <command>` text: name and title, the
// description, both usage forms, its flags, and the flags every command takes (with
// common; a reference listing many commands states those once, WriteCommonFlags).
func WriteHelp(w io.Writer, cmd *v1.Command, common bool) {
	name := cmd.GetName()
	fmt.Fprintf(w, "%s - %s\n", name, cmd.GetTitle())
	if d := cmd.GetDescription(); d != "" {
		fmt.Fprintf(w, "\n%s\n", d)
	}
	pos := PositionalUsage(cmd)
	fmt.Fprintf(w, "\nUsage:\n  code-foundry %s%s [flags]\n  code-foundry %s%s [flags]\n",
		name, pos, strings.ReplaceAll(name, ".", " "), pos)

	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	if len(cmd.GetArgs()) > 0 {
		fmt.Fprintln(tw, "\nFlags:")
		for _, a := range cmd.GetArgs() {
			flag, detail := helpFlag(a), ArgDetail(a)
			if ph := ArgPlaceholder(a); len(ph) > maxHelpPlaceholder {
				// A long enum (every model) would push every description far right.
				flag = "--" + a.GetName() + " value"
				detail += " (one of: " + strings.ReplaceAll(ph, "|", ", ") + ")"
			}
			fmt.Fprintf(tw, "  %s\t%s\n", flag, detail)
		}
	}
	if common {
		fmt.Fprintln(tw, "\nCommon flags:")
		writeCommonFlags(tw, cmd.GetRequiresConfirmation())
	} else if cmd.GetRequiresConfirmation() {
		fmt.Fprintln(tw, "\nAsks for confirmation: --yes confirms (required without a terminal).")
	}
	_ = tw.Flush()
	if kb := cmd.GetKeybindings(); len(kb) > 0 {
		fmt.Fprintf(w, "\nKeybindings: %s\n", strings.Join(kb, ", "))
	}
}

// maxHelpPlaceholder is the longest value placeholder WriteHelp puts in the flag column;
// a longer enum is "value" there and its values follow the description.
const maxHelpPlaceholder = 32

// helpFlag is a flag as WriteHelp's column shows it: "--until idle|attention",
// "--for string", and a bool "--sidebar[=false]" (a bool flag takes no separate word:
// `--sidebar false` is a flag and a stray word).
func helpFlag(a *v1.ArgSpec) string {
	if a.GetType() == v1.ArgType_ARG_TYPE_BOOL {
		return "--" + a.GetName() + "[=false]"
	}
	return "--" + a.GetName() + " " + ArgPlaceholder(a)
}

// WriteCommonFlags writes the flags every command takes, as WriteHelp lists them
// (without --yes, which only commands that ask take).
func WriteCommonFlags(w io.Writer) {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	writeCommonFlags(tw, false)
	_ = tw.Flush()
}

func writeCommonFlags(tw io.Writer, confirm bool) {
	fmt.Fprintln(tw, "  --json\tprint the structured result as JSON")
	if confirm {
		fmt.Fprintln(tw, "  --yes\tdo not ask for confirmation (required without a terminal)")
	}
	fmt.Fprintln(tw, "  --context-terminal id\tactive terminal, for availability and defaults")
	fmt.Fprintln(tw, "  --context-thread id\tactive thread (default $"+paths.EnvThread+", set in a thread's Claude process)")
	fmt.Fprintln(tw, "  --context-project id\tactive project")
	fmt.Fprintln(tw, "  --context-worktree path\tactive worktree")
	fmt.Fprintln(tw, "  --context-workspace id\tactive workspace")
}

// PositionalUsage is " <key> [<value>]" for a command's positional args.
func PositionalUsage(cmd *v1.Command) string {
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
