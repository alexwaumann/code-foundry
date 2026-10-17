package api

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func mcpSample(at time.Time) *thread.McpStatus {
	return &thread.McpStatus{CheckedAt: at, Trigger: thread.McpTriggerTurn, Servers: []thread.McpServer{
		{Name: "github", Status: thread.McpConnected, ServerName: "gh", Version: "1.2.0", Scope: "user", Source: "user", Transport: "stdio",
			Tools: []thread.McpTool{{Name: "get", Description: "Get", ReadOnly: true, OpenWorld: true}, {Name: "push", Destructive: true}}},
		{Name: "linear", Status: thread.McpNeedsAuth, Scope: "user", Transport: "http"},
		{Name: "playwright", Status: thread.McpFailed, Error: "spawn npx ENOENT", Scope: "project", Transport: "stdio"},
		{Name: "fs", Status: thread.McpPending, Scope: "local", Transport: "stdio"},
		{Name: "sentry", Status: thread.McpDisabled, Scope: "user", Transport: "http"},
		{Name: "odd", Status: "sleeping"},
	}}
}

func TestMcpStatusToProto(t *testing.T) {
	if mcpStatusToProto(nil) != nil {
		t.Error("nil status mapped to a message")
	}
	at := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	p := mcpStatusToProto(mcpSample(at))
	if !p.GetCheckedAt().AsTime().Equal(at) || p.GetTrigger() != v1.McpCheckTrigger_MCP_CHECK_TRIGGER_TURN_START || len(p.GetServers()) != 6 {
		t.Fatalf("status %v", p)
	}
	want := []v1.McpServerStatus{
		v1.McpServerStatus_MCP_SERVER_STATUS_CONNECTED, v1.McpServerStatus_MCP_SERVER_STATUS_NEEDS_AUTH, v1.McpServerStatus_MCP_SERVER_STATUS_FAILED,
		v1.McpServerStatus_MCP_SERVER_STATUS_PENDING, v1.McpServerStatus_MCP_SERVER_STATUS_DISABLED, v1.McpServerStatus_MCP_SERVER_STATUS_UNSPECIFIED,
	}
	for i, s := range p.GetServers() {
		if s.GetStatus() != want[i] {
			t.Errorf("server %s status %v want %v", s.GetName(), s.GetStatus(), want[i])
		}
	}
	gh := p.GetServers()[0]
	if gh.GetServerName() != "gh" || gh.GetVersion() != "1.2.0" || gh.GetTransport() != "stdio" || len(gh.GetTools()) != 2 ||
		!gh.GetTools()[0].GetReadOnly() || !gh.GetTools()[0].GetOpenWorld() || !gh.GetTools()[1].GetDestructive() || gh.GetTools()[1].GetReadOnly() {
		t.Errorf("github %v", gh)
	}
	if p.GetServers()[2].GetError() != "spawn npx ENOENT" {
		t.Errorf("playwright %v", p.GetServers()[2])
	}
	r := mcpStatusToProto(&thread.McpStatus{Trigger: thread.McpTriggerReconnect, Server: "linear"})
	if r.GetCheckedAt() != nil || r.GetTrigger() != v1.McpCheckTrigger_MCP_CHECK_TRIGGER_RECONNECT || r.GetServer() != "linear" {
		t.Errorf("reconnect status %v", r)
	}
}

func TestThreadMcp(t *testing.T) {
	fake, c := newThreadServer(t)
	fake.Put(thread.Thread{ID: "s1", State: thread.StateConnected})
	fake.PutItems("s1", thread.Item{ID: "u1", Kind: thread.KindUserMessage, Text: "hi"})
	fake.PutMcp("s1", mcpSample(time.Now()))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if _, err := c.McpStatus(ctx, connect.NewRequest(&v1.McpStatusRequest{ThreadId: "nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown thread: %v", err)
	}
	stream, err := c.WatchThread(ctx, connect.NewRequest(&v1.WatchThreadRequest{ThreadId: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	next := func() *v1.ThreadEvent {
		t.Helper()
		if !stream.Receive() {
			t.Fatalf("stream ended: %v", stream.Err())
		}
		return stream.Msg()
	}
	snap := next().GetSnapshot()
	if snap.GetSeq() != 2 || len(snap.GetMcp().GetServers()) != 6 {
		t.Fatalf("snapshot %v", snap)
	}

	got, err := c.McpStatus(ctx, connect.NewRequest(&v1.McpStatusRequest{ThreadId: "s1"}))
	if err != nil || len(got.Msg.GetStatus().GetServers()) != 6 {
		t.Fatalf("status %v %v", got, err)
	}
	ref, err := c.McpStatus(ctx, connect.NewRequest(&v1.McpStatusRequest{ThreadId: "s1", Refresh: true}))
	if err != nil || ref.Msg.GetStatus().GetTrigger() != v1.McpCheckTrigger_MCP_CHECK_TRIGGER_REFRESH {
		t.Fatalf("refresh %v %v", ref, err)
	}
	if ev := next().GetMcp(); ev.GetThreadId() != "s1" || ev.GetSeq() != 3 || ev.GetStatus().GetTrigger() != v1.McpCheckTrigger_MCP_CHECK_TRIGGER_REFRESH {
		t.Errorf("refresh event %v", ev)
	}

	rc, err := c.McpReconnect(ctx, connect.NewRequest(&v1.McpReconnectRequest{ThreadId: "s1", ServerName: "playwright"}))
	if err != nil {
		t.Fatal(err)
	}
	if st := rc.Msg.GetStatus(); rc.Msg.GetError() != "" || st.GetServer() != "playwright" || st.GetServers()[2].GetStatus() != v1.McpServerStatus_MCP_SERVER_STATUS_CONNECTED {
		t.Errorf("reconnect %v", rc.Msg)
	}
	if ev := next().GetMcp(); ev.GetStatus().GetTrigger() != v1.McpCheckTrigger_MCP_CHECK_TRIGGER_RECONNECT {
		t.Errorf("reconnect event %v", ev)
	}
	fake.SetMcpReconnectError("linear", "needs login")
	rc, err = c.McpReconnect(ctx, connect.NewRequest(&v1.McpReconnectRequest{ThreadId: "s1", ServerName: "linear"}))
	if err != nil || rc.Msg.GetError() != "needs login" || rc.Msg.GetStatus().GetServers()[1].GetStatus() != v1.McpServerStatus_MCP_SERVER_STATUS_NEEDS_AUTH {
		t.Errorf("failed reconnect %v %v", rc, err)
	}
	if _, err := c.McpReconnect(ctx, connect.NewRequest(&v1.McpReconnectRequest{ThreadId: "s1", ServerName: "nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown server: %v", err)
	}

	// Dropped (the process ended): an event without a status.
	fake.PutMcp("s1", nil)
	for {
		ev := next()
		if m := ev.GetMcp(); m != nil && m.GetStatus() == nil {
			break
		}
	}
	none, err := c.McpStatus(ctx, connect.NewRequest(&v1.McpStatusRequest{ThreadId: "s1"}))
	if err != nil || none.Msg.GetStatus() != nil {
		t.Errorf("no status %v %v", none, err)
	}
}
