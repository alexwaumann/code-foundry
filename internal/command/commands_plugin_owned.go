package command

import (
	"cmp"
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// plugin.threads and plugin.terminals (docs/notes/plugins-6-thread-terminal.md): what a
// plugin owns, which the user's lists leave out. A plugin's threads are thread.list's
// with --plugin <name> --archived; its terminals the terminals labelled for it.

// PluginOwnedDeps are plugin.threads' and plugin.terminals' dependencies.
type PluginOwnedDeps struct {
	Thread   ThreadBackend
	Project  ProjectBackend
	Terminal TerminalBackend
}

// RegisterPluginOwned registers plugin.threads and plugin.terminals.
func RegisterPluginOwned(r *Registry, d PluginOwnedDeps) error {
	nameArg := ArgSpec{Name: "name", Type: String, Required: true, Positional: true, Description: "Plugin name (code-foundry plugin list)"}
	return r.RegisterAll(
		Command{
			Name:     "plugin.threads",
			ReadOnly: true,
			Title:    "List Plugin Threads",
			Description: "List the Claude threads a plugin owns (thread/create), archived ones too, the most recently active " +
				"first. They are hidden from the sidebar and thread list; thread read, send and the other thread verbs " +
				"take their ids like any thread's.",
			Category:     "Plugin",
			NoKeybinding: true,
			Args:         []ArgSpec{nameArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				f := &v1.ThreadFilter{Owner: pluginOwner(a.String("name")), IncludeArchived: true}
				res, err := d.Thread.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: f}))
				if err != nil {
					return Result{}, err
				}
				if len(res.Msg.GetThreads()) == 0 {
					return Result{Message: fmt.Sprintf("plugin %s has no threads", a.String("name")), JSON: res.Msg}, nil
				}
				projects, err := d.Project.List(ctx, connect.NewRequest(&v1.ListProjectsRequest{}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: formatThreadList(res.Msg.GetThreads(), nil, projects.Msg.GetProjects(), nil, f, time.Now()), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:     "plugin.terminals",
			ReadOnly: true,
			Title:    "List Plugin Terminals",
			Description: "List the terminals a plugin owns (terminal/create): id, state, title, program and directory. " +
				"terminal kill and terminal close take their ids, and the side panel's terminal node or the bottom panel shows " +
				"them; the plugin closes them, and disabling it does too.",
			Category:     "Plugin",
			NoKeybinding: true,
			Args:         []ArgSpec{nameArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := d.Terminal.List(ctx, connect.NewRequest(&v1.ListTerminalsRequest{}))
				if err != nil {
					return Result{}, err
				}
				name := a.String("name")
				out := &v1.ListTerminalsResponse{}
				for _, t := range res.Msg.GetTerminals() {
					if l := t.GetLabels(); termlabel.IsPlugin(l) && l[termlabel.Plugin] == name {
						out.Terminals = append(out.Terminals, t)
					}
				}
				return Result{Message: formatPluginTerminals(name, out.GetTerminals()), JSON: out}, nil
			},
		},
	)
}

// formatPluginTerminals is plugin.terminals' text: one aligned line per terminal.
func formatPluginTerminals(name string, terms []*v1.Terminal) string {
	if len(terms) == 0 {
		return fmt.Sprintf("plugin %s has no terminals", name)
	}
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "ID\tSTATE\tTITLE\tPROGRAM\tCWD")
	for _, t := range terms {
		state := "running"
		if t.GetState() == v1.TerminalState_TERMINAL_STATE_EXITED {
			state = fmt.Sprintf("exited (%d)", t.GetExitCode())
		}
		prog := "-"
		if argv := t.GetArgv(); len(argv) > 0 {
			prog = filepath.Base(argv[0])
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", t.GetId(), state, cmp.Or(t.GetLabels()[termlabel.Title], t.GetTitle(), "-"), prog, t.GetCwd())
	}
	_ = tw.Flush()
	return strings.TrimRight(sb.String(), "\n")
}
