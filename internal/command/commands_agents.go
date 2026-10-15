package command

import (
	"context"
	"fmt"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// A thread's subagent runs (docs/notes/agents-1-daemon.md): thread.agents prints them,
// view.panel.agents opens the GUI's Agents surface.

// AgentsBackend is the slice of ThreadService the agents commands need (the runs come
// with the items snapshot), in generated Connect signatures.
type AgentsBackend interface {
	ListItems(context.Context, *connect.Request[v1.ListThreadItemsRequest]) (*connect.Response[v1.ListThreadItemsResponse], error)
}

var (
	_ AgentsBackend = codefoundryv1connect.ThreadServiceHandler(nil)
	_ AgentsBackend = codefoundryv1connect.ThreadServiceClient(nil)
)

// ViewPanelAgents is the ShowView name that opens (or reveals) the Agents surface in the
// side panel of the selected thread: its subagent runs with their status, activity and
// report. A window whose selection is not a thread ignores it.
const ViewPanelAgents = "panel.agents"

// RegisterAgents registers thread.agents and view.panel.agents.
func RegisterAgents(r *Registry, b AgentsBackend, e Emitter) error {
	return r.RegisterAll(
		Command{
			Name:  "thread.agents",
			Title: "Show Thread Agents",
			Description: "Print a thread's subagent runs in spawn order, foreground and background, nested ones under their parent: " +
				"type, model, mode, status, elapsed time, tool uses and tokens, then what each running one is doing and what each finished one reported.",
			Category: "Thread",
			Args:     []ArgSpec{{Name: "id", Type: String, Required: true, Context: ContextSession, Description: "Thread id"}},
			When:     hasSession,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.ListItems(ctx, connect.NewRequest(&v1.ListThreadItemsRequest{SessionId: a.String("id")}))
				if err != nil {
					return Result{}, err
				}
				snap := res.Msg.GetSnapshot()
				runs := snap.GetAgents()
				return Result{Message: FormatAgents(runs, time.Now()), JSON: &v1.ThreadAgentsChange{SessionId: snap.GetSessionId(), Seq: snap.GetSeq(), Agents: runs}}, nil
			},
		},
		Command{
			Name:        "view.panel.agents",
			Title:       "Show Agents",
			Description: "Open the Agents surface in the selected thread's side panel: its subagent runs with their status, activity and report.",
			Category:    "View",
			// No default chord, like view.panel.mcp (the surface has its own key while the
			// panel has focus).
			When: hasSession,
			Run: func(context.Context, Context, Args) (Result, error) {
				n := e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: ViewPanelAgents}}})
				return Result{JSON: EmitResult{Delivered: n}}, nil
			},
		},
	)
}

var agentStatusWords = map[v1.ThreadAgentStatus]string{
	v1.ThreadAgentStatus_THREAD_AGENT_STATUS_RUNNING: "running",
	v1.ThreadAgentStatus_THREAD_AGENT_STATUS_DONE:    "done",
	v1.ThreadAgentStatus_THREAD_AGENT_STATUS_FAILED:  "failed",
}

func agentStatusWord(s v1.ThreadAgentStatus) string {
	if w, ok := agentStatusWords[s]; ok {
		return w
	}
	return "unknown"
}

// agentRunning counts running runs: all, and the thread's own background ones (as the
// Session counts them).
func agentRunning(runs []*v1.ThreadAgentRun) (all, background int) {
	for _, r := range runs {
		if r.GetStatus() != v1.ThreadAgentStatus_THREAD_AGENT_STATUS_RUNNING {
			continue
		}
		all++
		if r.GetBackground() && r.GetSpawnDepth() <= 1 {
			background++
		}
	}
	return all, background
}

// agentLabel is a run's name: its description, else its type.
func agentLabel(r *v1.ThreadAgentRun) string {
	if name := r.GetDescription(); name != "" {
		return name
	}
	return dash(r.GetAgentType())
}

// agentName is a run's name in the table, nested runs marked under their parent.
func agentName(r *v1.ThreadAgentRun) string {
	name := agentLabel(r)
	if d := r.GetSpawnDepth(); d > 1 {
		name = strings.Repeat("  ", int(d)-2) + "↳ " + name
	}
	return name
}

// agentModel is the model as requested, with its effort; "inherit" when the thread's.
func agentModel(r *v1.ThreadAgentRun) string {
	m := r.GetModel()
	if m == "" {
		m = "inherit"
	}
	if e := r.GetEffort(); e != "" {
		m += " " + e
	}
	return m
}

// agentElapsed is how long a run has run: since it started (or last woke) while
// running, else Claude's duration, else its start to its end. 0 when unknown.
func agentElapsed(r *v1.ThreadAgentRun, now time.Time) time.Duration {
	from := r.GetStartedAt()
	if r.GetResumedAt() != nil {
		from = r.GetResumedAt()
	}
	switch {
	case r.GetStatus() == v1.ThreadAgentStatus_THREAD_AGENT_STATUS_RUNNING && from != nil:
		return max(now.Sub(from.AsTime()), 0)
	case r.GetDurationMs() > 0:
		return time.Duration(r.GetDurationMs()) * time.Millisecond
	case from != nil && r.GetEndedAt() != nil:
		return max(r.GetEndedAt().AsTime().Sub(from.AsTime()), 0)
	}
	return 0
}

// shortDuration is "12s", "3m 04s", "1h 02m"; "-" for none.
func shortDuration(d time.Duration) string {
	switch {
	case d <= 0:
		return "-"
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm %02ds", int(d.Minutes()), int(d.Seconds())%60)
	default:
		return fmt.Sprintf("%dh %02dm", int(d.Hours()), int(d.Minutes())%60)
	}
}

// shortTokens is "850", "14.1k", "1.2M"; "-" for none.
func shortTokens(n int64) string {
	switch {
	case n <= 0:
		return "-"
	case n < 1000:
		return fmt.Sprint(n)
	case n < 1_000_000:
		return fmt.Sprintf("%.1fk", float64(n)/1000)
	default:
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	}
}

// FormatAgents renders a thread's runs as a table (now times the running ones), then
// each running run's activity and each finished one's report or error.
func FormatAgents(runs []*v1.ThreadAgentRun, now time.Time) string {
	if len(runs) == 0 {
		return "no subagent runs in this thread"
	}
	all, background := agentRunning(runs)
	var b strings.Builder
	fmt.Fprintf(&b, "Agents: %d running (%d in the background) · %d this thread\n", all, background, len(runs))
	tw := tabwriter.NewWriter(&b, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "NAME\tTYPE\tMODEL\tMODE\tSTATUS\tELAPSED\tTOOLS\tTOKENS")
	for _, r := range runs {
		mode := "foreground"
		if r.GetBackground() {
			mode = "background"
		}
		tools := "-"
		if n := r.GetToolUses(); n > 0 {
			tools = fmt.Sprint(n)
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", agentName(r), dash(r.GetAgentType()), agentModel(r), mode,
			agentStatusWord(r.GetStatus()), shortDuration(agentElapsed(r, now)), tools, shortTokens(r.GetTotalTokens()))
	}
	_ = tw.Flush()
	var lines []string
	for _, r := range runs {
		var what string
		switch r.GetStatus() {
		case v1.ThreadAgentStatus_THREAD_AGENT_STATUS_RUNNING:
			what = firstLine(r.GetActivity())
			if t := r.GetLastTool(); t != "" {
				what = strings.TrimSpace(what + " (" + t + ")")
			}
		case v1.ThreadAgentStatus_THREAD_AGENT_STATUS_FAILED:
			what = "error: " + firstLine(r.GetError())
		default:
			what = firstLine(r.GetSummary())
		}
		if what != "" {
			lines = append(lines, fmt.Sprintf("%s: %s", agentLabel(r), what))
		}
	}
	if len(lines) > 0 {
		b.WriteString("\n" + strings.Join(lines, "\n"))
	}
	return strings.TrimRight(b.String(), "\n")
}
