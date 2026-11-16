package command

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
)

// Plugins' flags on threads (thread/setFlag, deprecated) are notifications naming the
// thread (docs/notes/plugin-flag-retirement.md): thread.flags lists a thread's,
// thread.flag.clear dismisses them as the user would in the bell. Plugins raise them
// through the plugin protocol, never through a command.

// FlagsBackend is the slice of ThreadService the flag commands need.
type FlagsBackend interface {
	ClearFlags(context.Context, *connect.Request[v1.ClearThreadFlagsRequest]) (*connect.Response[v1.ClearThreadFlagsResponse], error)
}

// WithFlagNotifications gives thread.flags the notification store that holds the flags
// (without it, a thread has none).
func WithFlagNotifications(s notification.Store) ThreadLifecycleOption {
	return func(o *threadLifecycleOptions) { o.notes = s }
}

// flagLevelNames are a flag notification's level as the flag's.
var flagLevelNames = map[notification.Level]string{notification.LevelWarning: "attention", notification.LevelError: "error"}

// flagView is one flag in thread.flags --json.
type flagView struct {
	Plugin         string    `json:"plugin"`
	Level          string    `json:"level"`
	Reason         string    `json:"reason"`
	SetAt          time.Time `json:"setAt"`
	UntilSeen      bool      `json:"untilSeen"`
	NotificationID string    `json:"notificationId"`
	Status         string    `json:"status"`
}

func flagViews(ns []notification.Notification) []flagView {
	out := []flagView{}
	for _, n := range ns {
		_, untilSeen, _ := notification.ParseFlagKey(n.Key)
		out = append(out, flagView{Plugin: n.Source, Level: flagLevelNames[n.Level], Reason: n.Title, SetAt: n.UpdatedAt,
			UntilSeen: untilSeen, NotificationID: n.ID, Status: string(n.Status())})
	}
	// As flags always sorted: errors first, then newest first, then by plugin.
	slices.SortStableFunc(out, func(a, b flagView) int {
		if (a.Level == "error") != (b.Level == "error") {
			if a.Level == "error" {
				return -1
			}
			return 1
		}
		if c := b.SetAt.Compare(a.SetAt); c != 0 {
			return c
		}
		return strings.Compare(a.Plugin, b.Plugin)
	})
	return out
}

// formatFlags is a thread's flags as a table, or a line saying it has none.
func formatFlags(s *v1.Thread, flags []flagView) string {
	if len(flags) == 0 {
		return "thread " + threadLabel(s) + " has no flags"
	}
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "PLUGIN\tLEVEL\tREASON\tSET\tUNTIL SEEN\tNOTIFICATION")
	for _, f := range flags {
		until := "no"
		if f.UntilSeen {
			until = "yes"
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s (%s)\n", f.Plugin, f.Level, f.Reason,
			f.SetAt.Local().Format(time.DateTime), until, f.NotificationID, f.Status)
	}
	_ = tw.Flush()
	return strings.TrimRight(sb.String(), "\n")
}

func threadFlagsCmd(b ThreadBackend, o threadLifecycleOptions, idArg ArgSpec) Command {
	idArg.Positional = true
	return Command{
		Name:      "thread.flags",
		NoPalette: true,
		ReadOnly:  true,
		Title:     "Show Thread Flags",
		Description: "List the flags plugins raised on a thread, which show as notifications naming it: plugin, level " +
			"(attention or error), reason, when, whether opening the thread dismisses it, and its notification.",
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
			var flags []flagView
			if o.notes != nil {
				flags = flagViews(notification.FlagsOn(o.notes.Snapshot(), s.GetId(), ""))
			}
			return Result{Message: formatFlags(s, flags)}.withFlags(s.GetId(), flags), nil
		},
	}
}

// withFlags sets r's JSON to thread.flags --json: {"threadId", "flags": [...]}.
func (r Result) withFlags(id string, flags []flagView) Result {
	if flags == nil {
		flags = []flagView{}
	}
	r.JSON = map[string]any{"threadId": id, "flags": flags}
	return r
}

func threadFlagClearCmd(b ThreadBackend, idArg ArgSpec) Command {
	idArg.Positional = true
	return Command{
		Name:         "thread.flag.clear",
		Page:         PageState,
		NoPalette:    true,
		Title:        "Clear Thread Flags",
		Description:  "Dismiss the flags plugins raised on a thread (their notifications): one plugin's with --plugin, else every one.",
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
