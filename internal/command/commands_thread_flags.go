package command

import (
	"context"
	"fmt"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Plugins' flags on threads (docs/notes/plugins-3-events-flags-env.md): thread.flags
// lists them, thread.flag.clear removes them. Plugins raise them through the plugin
// protocol, never through a command.

// FlagsBackend is the slice of ThreadService the flag commands need.
type FlagsBackend interface {
	ClearFlags(context.Context, *connect.Request[v1.ClearThreadFlagsRequest]) (*connect.Response[v1.ClearThreadFlagsResponse], error)
}

// flagLevelName is a flag level as the CLI spells it.
func flagLevelName(l v1.ThreadFlagLevel) string {
	return strings.ToLower(strings.TrimPrefix(l.String(), "THREAD_FLAG_LEVEL_"))
}

// formatFlags is a thread's flags as a table, or a line saying it has none.
func formatFlags(s *v1.Thread) string {
	if len(s.GetFlags()) == 0 {
		return "thread " + threadLabel(s) + " has no flags"
	}
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "PLUGIN\tLEVEL\tREASON\tSET\tUNTIL SEEN")
	for _, f := range s.GetFlags() {
		until := "no"
		if f.GetUntilSeen() {
			until = "yes"
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", f.GetPlugin(), flagLevelName(f.GetLevel()), f.GetReason(),
			f.GetSetAt().AsTime().Local().Format(time.DateTime), until)
	}
	_ = tw.Flush()
	return strings.TrimRight(sb.String(), "\n")
}

// flagJSON is one flag in thread.flags --json.
type flagJSON struct {
	Plugin            string    `json:"plugin"`
	PluginDisplayName string    `json:"pluginDisplayName"`
	Level             string    `json:"level"`
	Reason            string    `json:"reason"`
	SetAt             time.Time `json:"setAt"`
	UntilSeen         bool      `json:"untilSeen"`
}

// flagsJSON is thread.flags --json: {"threadId", "flags": [...]}.
func flagsJSON(s *v1.Thread) any {
	flags := []flagJSON{}
	for _, f := range s.GetFlags() {
		flags = append(flags, flagJSON{Plugin: f.GetPlugin(), PluginDisplayName: f.GetPluginDisplayName(), Level: flagLevelName(f.GetLevel()),
			Reason: f.GetReason(), SetAt: f.GetSetAt().AsTime(), UntilSeen: f.GetUntilSeen()})
	}
	return map[string]any{"threadId": s.GetId(), "flags": flags}
}

// flagsLine is thread.get's line about the flags; "" without any.
func flagsLine(s *v1.Thread) string {
	if len(s.GetFlags()) == 0 {
		return ""
	}
	parts := make([]string, len(s.GetFlags()))
	for i, f := range s.GetFlags() {
		parts[i] = fmt.Sprintf("%s %s: %s", f.GetPlugin(), flagLevelName(f.GetLevel()), f.GetReason())
	}
	return "flags: " + strings.Join(parts, "; ")
}

func threadFlagsCmd(b ThreadBackend, idArg ArgSpec) Command {
	idArg.Positional = true
	return Command{
		Name:     "thread.flags",
		ReadOnly: true,
		Title:    "Show Thread Flags",
		Description: "List the flags plugins raised on a thread: plugin, level (attention or error), reason, when, and whether " +
			"opening the thread clears it. A flagged thread counts as needing attention.",
		Category:     "Thread",
		NoKeybinding: true,
		Args:         []ArgSpec{idArg},
		When:         hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: a.String("id")}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			return Result{Message: formatFlags(s), JSON: flagsJSON(s)}, nil
		},
	}
}

func threadFlagClearCmd(b ThreadBackend, idArg ArgSpec) Command {
	idArg.Positional = true
	return Command{
		Name:         "thread.flag.clear",
		Title:        "Clear Thread Flags",
		Description:  "Remove the flags plugins raised on a thread: one plugin's with --plugin, else every one.",
		Category:     "Thread",
		NoKeybinding: true,
		Args:         []ArgSpec{idArg, {Name: "plugin", Type: String, Description: "Only this plugin's flag"}},
		When:         hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.ClearFlags(ctx, connect.NewRequest(&v1.ClearThreadFlagsRequest{Id: a.String("id"), Plugin: a.String("plugin")}))
			if err != nil {
				return Result{}, err
			}
			n := res.Msg.GetCleared()
			what := "flags"
			if n == 1 {
				what = "flag"
			}
			return Result{Message: fmt.Sprintf("cleared %d %s on thread %s", n, what, threadLabel(res.Msg.GetThread())), JSON: res.Msg}, nil
		},
	}
}
