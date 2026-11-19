package command

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// threadSnoozeEvents is thread.snooze.events: what a thread can be snoozed until now
// (docs/notes/snooze-until-event.md): its open, non-draft pull requests with their pending
// events, and running plugins' wake sources, each with the thread.snooze flags that pick it.
// The GUI's Until event menu reads its JSON.
func threadSnoozeEvents(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:         "thread.snooze.events",
		ReadOnly:     true,
		NoIndex:      true, // thread.snooze's description points here; the guide has no room
		Title:        "List Snooze Events",
		Description:  "List the events a thread can be snoozed until now: its open pull requests' pending events and plugins' wake sources.",
		Category:     "Thread",
		NoPalette:    true,
		NoKeybinding: true,
		Args:         []ArgSpec{positional(idArg)},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.SnoozeEvents(ctx, connect.NewRequest(&v1.SnoozeEventsRequest{Id: a.String("id")}))
			if err != nil {
				return Result{}, err
			}
			return Result{Message: snoozeEventsText(res.Msg), JSON: res.Msg}, nil
		},
	}
}

// snoozeEventsText lists the events one per line, each with its thread.snooze flags.
func snoozeEventsText(m *v1.SnoozeEventsResponse) string {
	var lines []string
	for _, p := range m.GetPullRequests() {
		lines = append(lines, fmt.Sprintf("#%d %s", p.GetNumber(), p.GetTitle()))
		for _, c := range p.GetConditions() {
			lines = append(lines, fmt.Sprintf("  --until-pr %s --on %s", p.GetTarget(), c))
		}
	}
	for _, p := range m.GetPlugins() {
		line := fmt.Sprintf("%s (%s): --until-plugin %s", p.GetTitle(), p.GetPluginName(), p.GetTarget())
		keys := make([]string, 0, len(p.GetArgs()))
		for k := range p.GetArgs() {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		for _, k := range keys {
			line += " --arg " + k + "=" + p.GetArgs()[k]
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return "nothing to snooze until: no open pull request with a pending event, and no running plugin's wake source"
	}
	return strings.Join(lines, "\n")
}
