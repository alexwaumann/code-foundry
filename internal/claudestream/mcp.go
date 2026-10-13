package claudestream

import (
	"context"
	"encoding/json"
	"fmt"
)

// MCP servers (docs/notes/mcp-panel.md). Claude reports its MCP servers two ways:
// system/init's mcp_servers (name, status, source; at the start of every turn) and the
// mcp_status control request (the full picture, any time). Nothing is pushed when a
// server's status changes, so a host asks again after each init and after its own
// mcp_reconnect.

// MCP server statuses (McpServer.Status, McpServerInit.Status).
const (
	McpConnected = "connected"
	McpFailed    = "failed"
	McpNeedsAuth = "needs-auth"
	McpPending   = "pending"
	McpDisabled  = "disabled"
)

// McpServerInit is one entry of system/init's mcp_servers.
type McpServerInit struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	// Source is where the definition came from: user, project, local, dynamic
	// (--mcp-config), plugin, claudeai, managed, ...
	Source string `json:"source,omitempty"`
}

// McpServer is one server of mcp_status's reply (sdk.d.ts McpServerStatus).
type McpServer struct {
	// Name is the config key, untrusted text (escape before display).
	Name   string `json:"name"`
	Status string `json:"status"`
	// ServerInfo is what the server said about itself; nil unless connected.
	ServerInfo *McpServerInfo `json:"serverInfo,omitempty"`
	// Error is why it failed.
	Error  string    `json:"error,omitempty"`
	Config McpConfig `json:"config"`
	// Scope is the configuration scope (user, project, local, dynamic, claudeai, ...).
	Scope string `json:"scope,omitempty"`
	// Source is where the definition came from (as McpServerInit.Source).
	Source string `json:"source,omitempty"`
	// Tools are the server's tools; empty unless connected.
	Tools []McpTool `json:"tools,omitempty"`
}

// McpServerInfo is a connected server's own name and version.
type McpServerInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// McpConfig is the part of a server's config the host shows: its transport.
type McpConfig struct {
	// Type is stdio (also when absent), sse, http, sdk or claudeai-proxy.
	Type string `json:"type,omitempty"`
}

// Transport is the server's transport: Type, "stdio" when absent.
func (c McpConfig) Transport() string {
	if c.Type == "" {
		return "stdio"
	}
	return c.Type
}

// McpTool is one tool of a connected server. Claude 2.1.296 sends no description for
// claude.ai connectors; annotations carry only the hints the server set to true.
type McpTool struct {
	Name        string             `json:"name"`
	Description string             `json:"description,omitempty"`
	Annotations McpToolAnnotations `json:"annotations"`
}

// McpToolAnnotations are a tool's hints, false when the server did not set them.
type McpToolAnnotations struct {
	ReadOnly    bool `json:"readOnly,omitempty"`
	Destructive bool `json:"destructive,omitempty"`
	OpenWorld   bool `json:"openWorld,omitempty"`
}

// ParseMcpStatus decodes mcp_status's success payload ({"mcpServers": [...]}). An
// empty payload is no servers.
func ParseMcpStatus(raw json.RawMessage) ([]McpServer, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var r struct {
		McpServers []McpServer `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("claudestream: mcp_status response: %w", err)
	}
	return r.McpServers, nil
}

// McpStatus asks for every MCP server's status, in Claude's order.
func (c *Conn) McpStatus(ctx context.Context) ([]McpServer, error) {
	raw, err := c.Request(ctx, ControlRequest{"subtype": SubtypeMcpStatus})
	if err != nil {
		return nil, err
	}
	return ParseMcpStatus(raw)
}

// McpReconnect reconnects one server (by its mcp_status name), also the way to pick up
// a login made out of band. It answers once the attempt is over; a server that still
// fails is a *ControlError carrying its error. Ask McpStatus afterwards for the result.
func (c *Conn) McpReconnect(ctx context.Context, server string) error {
	_, err := c.Request(ctx, ControlRequest{"subtype": SubtypeMcpReconnect, "serverName": server})
	return err
}
