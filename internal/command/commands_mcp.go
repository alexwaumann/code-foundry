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

// A thread's MCP servers (docs/notes/mcp-panel.md): thread.mcp prints them,
// thread.mcp-reconnect reconnects one, view.panel.mcp opens the GUI's MCP surface.

// McpBackend is the slice of ThreadService the MCP commands need, in generated Connect
// signatures. The API handler, any ThreadServiceHandler and a ThreadServiceClient
// satisfy it.
type McpBackend interface {
	McpStatus(context.Context, *connect.Request[v1.McpStatusRequest]) (*connect.Response[v1.McpStatusResponse], error)
	McpReconnect(context.Context, *connect.Request[v1.McpReconnectRequest]) (*connect.Response[v1.McpReconnectResponse], error)
	// view.panel.mcp --thread checks the thread exists.
	ThreadGetter
}

var (
	_ McpBackend = codefoundryv1connect.ThreadServiceHandler(nil)
	_ McpBackend = codefoundryv1connect.ThreadServiceClient(nil)
)

// ViewPanelMcp is the ShowView name that opens (or reveals) the MCP surface in the side
// panel of the selected thread: its MCP servers with status, tools and Reconnect. An
// action on per-selection GUI state like ViewPanelToggle; a window whose selection is
// not a thread ignores it.
const ViewPanelMcp = "panel.mcp"

// RegisterMcp registers thread.mcp, thread.mcp-reconnect and view.panel.mcp.
func RegisterMcp(r *Registry, b McpBackend, e Emitter) error {
	idArg := ArgSpec{Name: "id", Type: String, Required: true, Context: ContextThread, ID: ThreadID, Description: "Thread id" + IDHelp}
	return r.RegisterAll(
		Command{
			Name:      "thread.mcp",
			NoPalette: true,
			Title:     "Show Thread MCP Servers",
			Description: "Print a thread's MCP servers as Claude last reported them (checked at the start of every turn): " +
				"status, scope, transport, version and tool count; --full adds each server's tools.",
			Category:     "Thread",
			NoKeybinding: true,
			Args: []ArgSpec{
				positional(idArg),
				{Name: "refresh", Type: Bool, Description: "Ask Claude now instead of showing the last check (starts Claude if it is not running)"},
				{Name: "full", Type: Bool, Description: "List each server's tools with their hints"},
			},
			When: hasThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.McpStatus(ctx, connect.NewRequest(&v1.McpStatusRequest{ThreadId: a.String("id"), Refresh: a.Bool("refresh")}))
				if err != nil {
					return Result{}, err
				}
				st := res.Msg.GetStatus()
				return Result{Message: FormatMcpStatus(st, a.Bool("full"), time.Now()), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:      "thread.mcp-reconnect",
			NoPalette: true,
			Title:     "Reconnect Thread MCP Server",
			Description: "Reconnect one of a thread's MCP servers (starting Claude if it is not running), then check them again. " +
				"It picks up a login made with /mcp in an interactive claude (a bottom-panel shell).",
			Category: "Thread",
			Args: []ArgSpec{
				idArg,
				{Name: "server", Type: String, Required: true, Description: "The server's name as thread.mcp prints it"},
			},
			When: hasThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				name := a.String("server")
				res, err := b.McpReconnect(ctx, connect.NewRequest(&v1.McpReconnectRequest{ThreadId: a.String("id"), ServerName: name}))
				if err != nil {
					return Result{}, err
				}
				status := "not listed any more"
				for _, s := range res.Msg.GetStatus().GetServers() {
					if s.GetName() == name {
						status = mcpStatusWord(s.GetStatus())
					}
				}
				msg := fmt.Sprintf("reconnected %s: %s", name, status)
				if e := res.Msg.GetError(); e != "" {
					msg = fmt.Sprintf("reconnect %s failed: %s (%s)", name, e, status)
				}
				return Result{Message: msg, JSON: res.Msg}, nil
			},
		},
		Command{
			Name:  "view.panel.mcp",
			Title: "Show MCP Servers",
			Description: "Open the MCP surface in a thread's side panel (from a thread: its own; in the app: the selected one): " +
				"the thread's MCP servers with status, errors and tools, and Reconnect.",
			Category: "View",
			// No default chord: in the app the thread info card's MCP row opens it.
			When: hasThread,
			Args: panelThreadArgs(),
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				return showPanel(ctx, b, e, uctx, a, ViewPanelMcp, nil)
			},
		},
	)
}

var mcpStatusWords = map[v1.McpServerStatus]string{
	v1.McpServerStatus_MCP_SERVER_STATUS_CONNECTED:  "connected",
	v1.McpServerStatus_MCP_SERVER_STATUS_FAILED:     "failed",
	v1.McpServerStatus_MCP_SERVER_STATUS_NEEDS_AUTH: "needs login",
	v1.McpServerStatus_MCP_SERVER_STATUS_PENDING:    "connecting",
	v1.McpServerStatus_MCP_SERVER_STATUS_DISABLED:   "disabled",
}

func mcpStatusWord(s v1.McpServerStatus) string {
	if w, ok := mcpStatusWords[s]; ok {
		return w
	}
	return "unknown"
}

// mcpAgo is a short relative time: "just now", "12s ago", "3 min ago", "2 h ago".
func mcpAgo(d time.Duration) string {
	switch {
	case d < 5*time.Second:
		return "just now"
	case d < time.Minute:
		return fmt.Sprintf("%ds ago", int(d/time.Second))
	case d < time.Hour:
		return fmt.Sprintf("%d min ago", int(d/time.Minute))
	default:
		return fmt.Sprintf("%d h ago", int(d/time.Hour))
	}
}

// mcpCheckedLine says when and why the servers were checked, like the GUI's header.
func mcpCheckedLine(st *v1.ThreadMcpStatus, now time.Time) string {
	line := "checked"
	if at := st.GetCheckedAt(); at != nil {
		line += " " + mcpAgo(now.Sub(at.AsTime()))
	}
	switch st.GetTrigger() {
	case v1.McpCheckTrigger_MCP_CHECK_TRIGGER_TURN_START:
		line += ", at the start of the last turn"
	case v1.McpCheckTrigger_MCP_CHECK_TRIGGER_RECONNECT:
		line += ", after reconnecting " + st.GetServer()
	}
	return line
}

// toolHints names a tool's hints: read-only or writes, destructive, open-world.
func toolHints(t *v1.McpTool) string {
	hints := []string{"writes"}
	if t.GetReadOnly() {
		hints[0] = "read-only"
	}
	if t.GetDestructive() {
		hints = append(hints, "destructive")
	}
	if t.GetOpenWorld() {
		hints = append(hints, "open-world")
	}
	return strings.Join(hints, ", ")
}

// FormatMcpStatus renders a thread's MCP servers as a table (now dates the check); full
// lists each server's tools under it. A nil status: Claude never reported them.
func FormatMcpStatus(st *v1.ThreadMcpStatus, full bool, now time.Time) string {
	if st == nil {
		return "no MCP status yet: Claude has not reported this thread's MCP servers"
	}
	servers := st.GetServers()
	if len(servers) == 0 {
		return "no MCP servers (" + mcpCheckedLine(st, now) + ")"
	}
	connected := 0
	for _, s := range servers {
		if s.GetStatus() == v1.McpServerStatus_MCP_SERVER_STATUS_CONNECTED {
			connected++
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "MCP servers: %d of %d connected (%s)\n", connected, len(servers), mcpCheckedLine(st, now))
	tw := tabwriter.NewWriter(&b, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "SERVER\tSTATUS\tSCOPE\tTRANSPORT\tVERSION\tTOOLS")
	for _, s := range servers {
		tools := "-"
		if s.GetStatus() == v1.McpServerStatus_MCP_SERVER_STATUS_CONNECTED {
			tools = fmt.Sprint(len(s.GetTools()))
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", s.GetName(), mcpStatusWord(s.GetStatus()), dash(s.GetScope()), dash(s.GetTransport()), dash(s.GetVersion()), tools)
	}
	_ = tw.Flush()
	for _, s := range servers {
		var lines []string
		if e := s.GetError(); e != "" {
			lines = append(lines, "  error: "+e)
		}
		if s.GetStatus() == v1.McpServerStatus_MCP_SERVER_STATUS_NEEDS_AUTH {
			lines = append(lines, "  needs login: run claude in a shell and log in with /mcp, then thread mcp-reconnect --server '"+s.GetName()+"'")
		}
		if full && len(s.GetTools()) > 0 {
			var tb strings.Builder
			ttw := tabwriter.NewWriter(&tb, 0, 0, 2, ' ', 0)
			for _, t := range s.GetTools() {
				fmt.Fprintf(ttw, "  %s\t%s\t%s\n", t.GetName(), toolHints(t), firstLine(t.GetDescription()))
			}
			_ = ttw.Flush()
			for _, l := range strings.Split(strings.TrimRight(tb.String(), "\n"), "\n") {
				lines = append(lines, strings.TrimRight(l, " "))
			}
		}
		if len(lines) > 0 {
			fmt.Fprintf(&b, "\n%s\n%s\n", s.GetName(), strings.Join(lines, "\n"))
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// firstLine is s's first line, cut to 100 runes.
func firstLine(s string) string {
	s, _, _ = strings.Cut(strings.TrimSpace(s), "\n")
	if r := []rune(s); len(r) > 100 {
		return string(r[:100]) + "…"
	}
	return s
}
