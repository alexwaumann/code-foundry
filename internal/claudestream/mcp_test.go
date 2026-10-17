package claudestream

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// The mcp fixture is a real run (Claude Code 2.1.296, haiku, the probe project, plus a
// --mcp-config server that cannot start): system/init (trimmed to its MCP fields), then
// mcp_status, mcp_reconnect of the broken server (an error), mcp_reconnect of a
// needs-auth claude.ai connector (success), and mcp_status again.
func TestMcpFixture(t *testing.T) {
	lines := fixture(t, "mcp")
	if len(lines) != 5 {
		t.Fatalf("%d lines", len(lines))
	}
	init, ok := Parse(lines[0]).(*Init)
	if !ok {
		t.Fatalf("line 0 is %T", Parse(lines[0]))
	}
	wantInit := []McpServerInit{
		{Name: "broken", Status: McpFailed, Source: "dynamic"},
		{Name: "claude.ai Claude Docs", Status: McpConnected, Source: "claudeai"},
		{Name: "claude.ai Google Drive", Status: McpNeedsAuth, Source: "claudeai"},
		{Name: "claude.ai Google Calendar", Status: McpNeedsAuth, Source: "claudeai"},
		{Name: "claude.ai Gmail", Status: McpNeedsAuth, Source: "claudeai"},
	}
	if !reflect.DeepEqual(init.McpServers, wantInit) {
		t.Errorf("init mcp_servers = %+v", init.McpServers)
	}
	reply := func(i int) *controlResponseLine {
		t.Helper()
		r, ok := Parse(lines[i]).(*controlResponseLine)
		if !ok {
			t.Fatalf("line %d is %T", i, Parse(lines[i]))
		}
		return r
	}
	before, err := ParseMcpStatus(reply(1).Response.Response)
	if err != nil {
		t.Fatal(err)
	}
	summary := func(ss []McpServer) []string {
		var out []string
		for _, s := range ss {
			out = append(out, s.Name+" "+s.Status+" "+s.Scope+" "+s.Config.Transport())
		}
		return out
	}
	wantBefore := []string{
		"broken failed dynamic stdio",
		"claude.ai Claude Docs connected claudeai claudeai-proxy",
		"claude.ai Google Drive needs-auth claudeai claudeai-proxy",
		"claude.ai Google Calendar needs-auth claudeai claudeai-proxy",
		"claude.ai Gmail needs-auth claudeai claudeai-proxy",
	}
	if got := summary(before); !reflect.DeepEqual(got, wantBefore) {
		t.Errorf("before = %q", got)
	}
	broken := before[0]
	if !strings.Contains(broken.Error, "ENOENT") || broken.ServerInfo != nil || len(broken.Tools) != 0 || broken.Source != "dynamic" {
		t.Errorf("broken = %+v", broken)
	}
	docs := before[1]
	if docs.ServerInfo == nil || docs.ServerInfo.Name != "Claude Docs" || docs.ServerInfo.Version != "0.1.0" || len(docs.Tools) != 8 {
		t.Errorf("docs = %+v", docs)
	}
	if tl := docs.Tools[1]; tl.Name != "read" || !tl.Annotations.ReadOnly || tl.Annotations.Destructive || tl.Description != "" {
		t.Errorf("docs read tool = %+v", tl)
	}
	if tl := docs.Tools[3]; tl.Name != "delete" || !tl.Annotations.Destructive || tl.Annotations.ReadOnly {
		t.Errorf("docs delete tool = %+v", tl)
	}

	if r := reply(2); r.Response.Subtype != "error" || !strings.Contains(r.Response.Error, "ENOENT") {
		t.Errorf("reconnect broken = %+v", r.Response)
	}
	if r := reply(3); r.Response.Subtype != "success" || len(r.Response.Response) != 0 {
		t.Errorf("reconnect gmail = %+v", r.Response)
	}
	after, err := ParseMcpStatus(reply(4).Response.Response)
	if err != nil {
		t.Fatal(err)
	}
	gmail := after[4]
	if gmail.Name != "claude.ai Gmail" || gmail.Status != McpConnected || gmail.ServerInfo == nil || len(gmail.Tools) != 23 {
		t.Errorf("gmail after reconnect = %+v", gmail)
	}
}

func TestParseMcpStatus(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		want    []McpServer
		wantErr bool
	}{
		{name: "empty payload", raw: ``, want: nil},
		{name: "no servers", raw: `{"mcpServers":[]}`, want: []McpServer{}},
		{name: "bad json", raw: `{"mcpServers":{}}`, wantErr: true},
		{
			name: "connected with tools",
			raw: `{"mcpServers":[{"name":"github","status":"connected","serverInfo":{"name":"gh","version":"1.2.0"},"config":{"type":"http","url":"https://x"},"scope":"user","source":"user",
				"tools":[{"name":"get","description":"Get it","annotations":{"readOnly":true,"openWorld":true}},{"name":"push","annotations":{"destructive":true}},{"name":"bare"}]}]}`,
			want: []McpServer{{
				Name: "github", Status: McpConnected, ServerInfo: &McpServerInfo{Name: "gh", Version: "1.2.0"},
				Config: McpConfig{Type: "http"}, Scope: "user", Source: "user",
				Tools: []McpTool{
					{Name: "get", Description: "Get it", Annotations: McpToolAnnotations{ReadOnly: true, OpenWorld: true}},
					{Name: "push", Annotations: McpToolAnnotations{Destructive: true}},
					{Name: "bare"},
				},
			}},
		},
		{
			name: "failed without serverInfo",
			raw:  `{"mcpServers":[{"name":"pw","status":"failed","error":"spawn npx ENOENT","config":{"command":"npx"},"scope":"project"}]}`,
			want: []McpServer{{Name: "pw", Status: McpFailed, Error: "spawn npx ENOENT", Scope: "project"}},
		},
		{
			name: "needs-auth, pending, disabled",
			raw:  `{"mcpServers":[{"name":"a","status":"needs-auth","config":{"type":"sse"}},{"name":"b","status":"pending","config":{"type":"stdio"}},{"name":"c","status":"disabled"}]}`,
			want: []McpServer{
				{Name: "a", Status: McpNeedsAuth, Config: McpConfig{Type: "sse"}},
				{Name: "b", Status: McpPending, Config: McpConfig{Type: "stdio"}},
				{Name: "c", Status: McpDisabled},
			},
		},
		{
			name: "unknown status and fields pass through",
			raw:  `{"mcpServers":[{"name":"x","status":"sleeping","extra":1}],"more":true}`,
			want: []McpServer{{Name: "x", Status: "sleeping"}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseMcpStatus(json.RawMessage(tt.raw))
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v", err)
			}
			if !tt.wantErr && !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %+v\nwant %+v", got, tt.want)
			}
		})
	}
}

func TestMcpTransport(t *testing.T) {
	for typ, want := range map[string]string{"": "stdio", "stdio": "stdio", "http": "http", "claudeai-proxy": "claudeai-proxy"} {
		if got := (McpConfig{Type: typ}).Transport(); got != want {
			t.Errorf("Transport(%q) = %q", typ, got)
		}
	}
}

func TestConnMcp(t *testing.T) {
	f := newFakeCLI(t, Options{})
	ctx := context.Background()

	type statusRes struct {
		servers []McpServer
		err     error
	}
	sc := make(chan statusRes, 1)
	go func() {
		s, err := f.conn.McpStatus(ctx)
		sc <- statusRes{s, err}
	}()
	req := f.read()
	if req["type"] != "control_request" || req["request"].(map[string]any)["subtype"] != "mcp_status" {
		t.Fatalf("status request = %v", req)
	}
	f.emit(`{"type":"control_response","response":{"subtype":"success","request_id":"` + req["request_id"].(string) + `","response":{"mcpServers":[{"name":"a","status":"connected"}]}}}`)
	if r := <-sc; r.err != nil || len(r.servers) != 1 || r.servers[0].Name != "a" {
		t.Errorf("McpStatus = %+v, %v", r.servers, r.err)
	}

	ec := make(chan error, 1)
	go func() { ec <- f.conn.McpReconnect(ctx, "claude.ai Gmail") }()
	req = f.read()
	body := req["request"].(map[string]any)
	if body["subtype"] != "mcp_reconnect" || body["serverName"] != "claude.ai Gmail" {
		t.Fatalf("reconnect request = %v", req)
	}
	f.emit(`{"type":"control_response","response":{"subtype":"success","request_id":"` + req["request_id"].(string) + `"}}`)
	if err := <-ec; err != nil {
		t.Errorf("McpReconnect = %v", err)
	}

	go func() { ec <- f.conn.McpReconnect(ctx, "broken") }()
	req = f.read()
	f.emit(`{"type":"control_response","response":{"subtype":"error","request_id":"` + req["request_id"].(string) + `","error":"ENOENT: no such file or directory, posix_spawn 'stdio'"}}`)
	var ce *ControlError
	if err := <-ec; !errors.As(err, &ce) || ce.Subtype != "mcp_reconnect" || !strings.Contains(ce.Message, "ENOENT") {
		t.Errorf("McpReconnect broken = %v", err)
	}
}
