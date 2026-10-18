package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// The read-only subagent view: a thread's own subagent run (spawn depth 1) shown in the
// content pane like a thread page, its prompt, work log and report, while the thread
// stays selected. thread.agent.open shows one, thread.agent.up goes back to the thread.

// ViewSubagent is the UiContext.active_view the GUI sends while it shows a subagent run
// of the selected thread. thread.agent.up is available there (and from the CLI) only.
const ViewSubagent = "thread.agent"

// ViewAgentUp is the ShowView name that leaves the subagent view for its parent thread
// (thread.agent.up from the CLI). Like ViewPanelToggle it is an action on the window's
// own state, not a page; a window that shows no subagent ignores it.
const ViewAgentUp = "agent.up"

// inSubagentView is thread.agent.up's availability: the GUI shows a subagent run, or the
// CLI (ActiveView is empty only there), which asks every window to go back up.
func inSubagentView(c Context) bool {
	return c.ActiveView == ViewSubagent || c.ActiveView == ""
}

// findAgentRun is the run of runs with id ref, else the one whose id starts with ref.
// Only a thread's own runs (spawn depth 1) open: the stream never carries a deeper run's
// messages, so there is nothing to show for one.
func findAgentRun(runs []*v1.ThreadAgentRun, threadID, ref string) (*v1.ThreadAgentRun, error) {
	var match []*v1.ThreadAgentRun
	for _, r := range runs {
		if r.GetId() == ref {
			match = []*v1.ThreadAgentRun{r}
			break
		}
		if strings.HasPrefix(r.GetId(), ref) {
			match = append(match, r)
		}
	}
	switch {
	case len(match) == 0:
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("thread %s has no agent run %q (see thread agents --json)", threadID, ref))
	case len(match) > 1:
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("agent run %q is ambiguous in thread %s: %d runs start with it", ref, threadID, len(match)))
	}
	r := match[0]
	if r.GetSpawnDepth() > 1 {
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("agent run %s was spawned by another agent: only a thread's own runs open", r.GetId()))
	}
	return r, nil
}

// agentViewCommands are thread.agent.open and thread.agent.up (registered by RegisterAgents).
func agentViewCommands(b AgentsBackend, e Emitter) []Command {
	return []Command{
		{
			Name:  "thread.agent.open",
			Title: "Open Subagent",
			Description: "Show one of a thread's own subagent runs read-only in the GUI: its prompt, work log and report, under the thread. " +
				"The run is its id from thread agents --json, or the start of it.",
			Category: "Thread",
			// A verb that drives the GUI with a run id the palette cannot pick: the GUI opens
			// runs from their Agent rows, the strip above the composer and the Agents tab.
			NoKeybinding: true,
			Args: []ArgSpec{
				{Name: "run", Type: String, Required: true, Positional: true, Description: "Agent run id (or its start)"},
				{Name: "id", Type: String, Required: true, Context: ContextThread, ID: ThreadID, Description: "Thread id" + IDHelp},
			},
			When: hasThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("id")
				res, err := b.ListItems(ctx, connect.NewRequest(&v1.ListThreadItemsRequest{ThreadId: id}))
				if err != nil {
					return Result{}, err
				}
				run, err := findAgentRun(res.Msg.GetSnapshot().GetAgents(), id, a.String("run"))
				if err != nil {
					return Result{}, err
				}
				n := e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_ShowAgentRun_{ShowAgentRun: &v1.UiIntent_ShowAgentRun{ThreadId: id, RunId: run.GetId()}}})
				// No Message: the GUI toasts non-empty ones, and the view is feedback enough.
				return Result{JSON: EmitResult{Delivered: n}}, nil
			},
		},
		{
			Name:        "thread.agent.up",
			Title:       "Back to Parent Thread",
			Description: "Leave the subagent view for the thread that ran the subagent.",
			Category:    "Thread",
			// Escape, offered only while the GUI shows a subagent (ViewSubagent). A bare key
			// fires only inside the content pane and outside elements with keys of their own
			// (gui/frontend/src/keys/bindings.ts chordFires), and the view has no composer.
			Keybindings: []string{"escape"},
			When:        inSubagentView,
			Run: func(context.Context, Context, Args) (Result, error) {
				n := e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: ViewAgentUp}}})
				return Result{JSON: EmitResult{Delivered: n}}, nil
			},
		},
	}
}
