package api

import (
	"context"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// A thread's MCP servers (docs/notes/mcp-panel.md).

// McpStatus returns the thread's MCP servers as last checked, or checks now.
func (h *Thread) McpStatus(ctx context.Context, req *connect.Request[v1.McpStatusRequest]) (*connect.Response[v1.McpStatusResponse], error) {
	s, err := h.store.McpStatus(ctx, req.Msg.GetThreadId(), req.Msg.GetRefresh())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.McpStatusResponse{Status: mcpStatusToProto(s)}), nil
}

// McpReconnect reconnects one server and returns the servers checked afterwards.
func (h *Thread) McpReconnect(ctx context.Context, req *connect.Request[v1.McpReconnectRequest]) (*connect.Response[v1.McpReconnectResponse], error) {
	res, err := h.store.McpReconnect(ctx, req.Msg.GetThreadId(), req.Msg.GetServerName())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.McpReconnectResponse{Status: mcpStatusToProto(res.Status), Error: res.Error}), nil
}

var mcpServerStatuses = map[string]v1.McpServerStatus{
	thread.McpConnected: v1.McpServerStatus_MCP_SERVER_STATUS_CONNECTED,
	thread.McpFailed:    v1.McpServerStatus_MCP_SERVER_STATUS_FAILED,
	thread.McpNeedsAuth: v1.McpServerStatus_MCP_SERVER_STATUS_NEEDS_AUTH,
	thread.McpPending:   v1.McpServerStatus_MCP_SERVER_STATUS_PENDING,
	thread.McpDisabled:  v1.McpServerStatus_MCP_SERVER_STATUS_DISABLED,
}

var mcpTriggers = map[thread.McpTrigger]v1.McpCheckTrigger{
	thread.McpTriggerTurn:      v1.McpCheckTrigger_MCP_CHECK_TRIGGER_TURN_START,
	thread.McpTriggerRefresh:   v1.McpCheckTrigger_MCP_CHECK_TRIGGER_REFRESH,
	thread.McpTriggerReconnect: v1.McpCheckTrigger_MCP_CHECK_TRIGGER_RECONNECT,
}

// mcpStatusToProto maps a status; nil (none) maps to nil.
func mcpStatusToProto(s *thread.McpStatus) *v1.ThreadMcpStatus {
	if s == nil {
		return nil
	}
	out := &v1.ThreadMcpStatus{Trigger: mcpTriggers[s.Trigger], Server: s.Server, Servers: make([]*v1.McpServer, len(s.Servers))}
	if !s.CheckedAt.IsZero() {
		out.CheckedAt = timestamppb.New(s.CheckedAt)
	}
	for i, sv := range s.Servers {
		p := &v1.McpServer{
			Name: sv.Name, Status: mcpServerStatuses[sv.Status], ServerName: sv.ServerName, Version: sv.Version,
			Error: sv.Error, Scope: sv.Scope, Source: sv.Source, Transport: sv.Transport,
		}
		for _, t := range sv.Tools {
			p.Tools = append(p.Tools, &v1.McpTool{Name: t.Name, Description: t.Description, ReadOnly: t.ReadOnly, Destructive: t.Destructive, OpenWorld: t.OpenWorld})
		}
		out.Servers[i] = p
	}
	return out
}
