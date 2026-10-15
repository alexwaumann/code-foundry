package session

import (
	"errors"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

func TestMcpFromWire(t *testing.T) {
	tests := []struct {
		name string
		in   claudestream.McpServer
		want McpServer
	}{
		{
			name: "connected with tools",
			in: claudestream.McpServer{
				Name: "github", Status: "connected", ServerInfo: &claudestream.McpServerInfo{Name: "gh", Version: "1.2.0"},
				Config: claudestream.McpConfig{Type: "http"}, Scope: "user", Source: "user",
				Tools: []claudestream.McpTool{
					{Name: "get", Description: "Get it", Annotations: claudestream.McpToolAnnotations{ReadOnly: true, OpenWorld: true}},
					{Name: "push", Annotations: claudestream.McpToolAnnotations{Destructive: true}},
					{Name: "bare"},
				},
			},
			want: McpServer{
				Name: "github", Status: McpConnected, ServerName: "gh", Version: "1.2.0", Scope: "user", Source: "user", Transport: "http",
				Tools: []McpTool{{Name: "get", Description: "Get it", ReadOnly: true, OpenWorld: true}, {Name: "push", Destructive: true}, {Name: "bare"}},
			},
		},
		{
			name: "failed, no serverInfo, stdio by default",
			in:   claudestream.McpServer{Name: "pw", Status: "failed", Error: "spawn npx ENOENT", Scope: "project"},
			want: McpServer{Name: "pw", Status: McpFailed, Error: "spawn npx ENOENT", Scope: "project", Transport: "stdio"},
		},
		{name: "needs-auth", in: claudestream.McpServer{Name: "a", Status: "needs-auth", Config: claudestream.McpConfig{Type: "claudeai-proxy"}},
			want: McpServer{Name: "a", Status: McpNeedsAuth, Transport: "claudeai-proxy"}},
		{name: "pending", in: claudestream.McpServer{Name: "b", Status: "pending"}, want: McpServer{Name: "b", Status: McpPending, Transport: "stdio"}},
		{name: "disabled", in: claudestream.McpServer{Name: "c", Status: "disabled", Config: claudestream.McpConfig{Type: "sse"}},
			want: McpServer{Name: "c", Status: McpDisabled, Transport: "sse"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := mcpFromWire([]claudestream.McpServer{tt.in})
			if len(got) != 1 || !reflect.DeepEqual(got[0], tt.want) {
				t.Errorf("got %+v\nwant %+v", got, tt.want)
			}
		})
	}
	if got := mcpFromWire(nil); got == nil || len(got) != 0 {
		t.Errorf("no servers = %#v", got)
	}
}

func TestMcpStatusCounts(t *testing.T) {
	s := &McpStatus{Servers: []McpServer{{Name: "a", Status: McpConnected}, {Name: "b", Status: McpPending}, {Name: "c", Status: McpConnected}}}
	if s.Connected() != 2 || !s.anyPending() {
		t.Errorf("connected %d pending %v", s.Connected(), s.anyPending())
	}
	if _, ok := s.server("b"); !ok {
		t.Error("server b not found")
	}
	if _, ok := s.server("B"); ok {
		t.Error("names are case-sensitive")
	}
}

// Answers apply in ticket order: an older check's answer arriving late is dropped, and
// a process end drops every check in flight but keeps the status.
func TestThreadLogMcpTickets(t *testing.T) {
	b := bus.New()
	sub := bus.Subscribe[ThreadEvent](b, 16)
	defer sub.Close()
	log := newThreadLog("s1", b, time.Now, nil)
	first, second := log.mcpTicket(), log.mcpTicket()
	a := &McpStatus{Trigger: McpTriggerTurn}
	c := &McpStatus{Trigger: McpTriggerRefresh}
	if !log.setMcp(second, c) {
		t.Fatal("newer answer not applied")
	}
	if log.setMcp(first, a) {
		t.Error("older answer applied over a newer one")
	}
	if log.mcpStatus() != c || log.snapshot().Mcp != c {
		t.Errorf("status = %+v", log.mcpStatus())
	}
	inFlight := log.mcpTicket()
	log.dropMcpChecks() // the process ended
	if log.setMcp(inFlight, a) || log.mcpStatus() != c {
		t.Error("an answer from before the process ended applied, or the status was dropped")
	}
	var got []string
	for len(sub.C()) > 0 {
		ev := <-sub.C()
		mc, ok := ev.(McpChanged)
		if !ok {
			t.Fatalf("event %T", ev)
		}
		got = append(got, string(statusTrigger(mc.Status)))
	}
	if want := []string{"refresh"}; !slices.Equal(got, want) {
		t.Errorf("events %q want %q", got, want)
	}
	if next := log.mcpTicket(); !log.setMcp(next, a) {
		t.Error("a check after the process ended was dropped")
	}
}

func statusTrigger(s *McpStatus) McpTrigger {
	if s == nil {
		return "nil"
	}
	return s.Trigger
}

func mcpFixture() string {
	p, _ := filepath.Abs(filepath.Join("..", "..", "claudestream", "testdata", "mcp.jsonl"))
	return p
}

func (re *env) waitMcp(id, what string, cond func(*McpStatus) bool) *McpStatus {
	re.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		s := re.items(id).Mcp
		if cond(s) {
			return s
		}
		if time.Now().After(deadline) {
			re.t.Fatalf("timed out waiting for MCP %s; have %+v", what, s)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func serverOf(t *testing.T, s *McpStatus, name string) McpServer {
	t.Helper()
	sv, ok := s.server(name)
	if !ok {
		t.Fatalf("no server %q in %+v", name, s)
	}
	return sv
}

// system/init makes the runner ask mcp_status; the answer is cached on the thread
// (ItemsSnapshot.Mcp) and published as McpChanged in the thread's seq order.
func TestRenderedMcpOnInit(t *testing.T) {
	re := newFixtureEnvAt(t, fixturePath("text-table"), []string{"CF_FAKE_CLAUDE_MCP=" + mcpFixture()})
	sub := bus.Subscribe[ThreadEvent](re.bus, 1024)
	defer sub.Close()
	s := re.create(CreateOptions{InitialPrompt: "a table please"})
	re.waitFor(s.ID, "connected", func(s Session) bool { return s.State == StateConnected })
	got := re.waitMcp(s.ID, "after init", func(m *McpStatus) bool { return m != nil })
	if got.Trigger != McpTriggerTurn || got.CheckedAt.IsZero() || len(got.Servers) != 5 || got.Connected() != 1 {
		t.Fatalf("status %+v", got)
	}
	if b := serverOf(t, got, "broken"); b.Status != McpFailed || !strings.Contains(b.Error, "ENOENT") || b.Transport != "stdio" || b.Scope != "dynamic" {
		t.Errorf("broken %+v", b)
	}
	if d := serverOf(t, got, "claude.ai Claude Docs"); d.Status != McpConnected || d.ServerName != "Claude Docs" || d.Version != "0.1.0" ||
		d.Transport != "claudeai-proxy" || len(d.Tools) != 8 || !d.Tools[1].ReadOnly {
		t.Errorf("docs %+v", d)
	}
	// Asked after the init line, i.e. after the prompt.
	sent := re.sent()
	user := slices.IndexFunc(sent, func(m map[string]any) bool { return m["type"] == "user" })
	status := slices.IndexFunc(sent, func(m map[string]any) bool {
		r, _ := m["request"].(map[string]any)
		return r["subtype"] == "mcp_status"
	})
	if user < 0 || status < user {
		t.Errorf("mcp_status at %d, user message at %d", status, user)
	}
	// The event carries the snapshot's seq.
	snap := re.items(s.ID)
	var ev *McpChanged
	for len(sub.C()) > 0 {
		if e, ok := (<-sub.C()).(McpChanged); ok && e.SessionID == s.ID {
			ev = &e
		}
	}
	if ev == nil || ev.Status != got || ev.Seq == 0 || ev.Seq > snap.Seq {
		t.Errorf("event %+v (snapshot seq %d)", ev, snap.Seq)
	}

	// The cache answers without asking again.
	before := len(re.sent())
	if cached, err := re.m.McpStatus(re.ctx(), s.ID, false); err != nil || cached != got {
		t.Errorf("cached = %+v, %v", cached, err)
	}
	if n := len(re.sent()); n != before {
		t.Errorf("a cached read wrote %d lines", n-before)
	}
	fresh, err := re.m.McpStatus(re.ctx(), s.ID, true)
	if err != nil || fresh.Trigger != McpTriggerRefresh || fresh == got || re.items(s.ID).Mcp != fresh {
		t.Errorf("refresh = %+v, %v", fresh, err)
	}

	// The process ends: the last check stays, and a cached read does not start Claude.
	if err := re.m.Close(re.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if m, err := re.m.McpStatus(re.ctx(), s.ID, false); m != fresh || err != nil {
		t.Errorf("stopped status = %+v, %v", m, err)
	}
	if re.items(s.ID).Mcp != fresh {
		t.Errorf("snapshot of a stopped thread lost its MCP status")
	}
	if got := re.snapshot(s.ID); got.State != StateDisconnected {
		t.Errorf("a cached read started the thread: %+v", got)
	}
	// Asked again: Claude starts without a prompt and answers.
	again, err := re.m.McpStatus(re.ctx(), s.ID, true)
	if err != nil || again == fresh || again.Trigger != McpTriggerRefresh {
		t.Errorf("stopped refresh = %+v, %v", again, err)
	}
	if got := re.snapshot(s.ID); got.State != StateConnected || got.Status == StatusBusy {
		t.Errorf("after the refresh %+v", got)
	}
	if err := re.m.Close(re.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := re.m.McpReconnect(re.ctx(), s.ID, "broken"); err != nil {
		t.Errorf("stopped reconnect: %v", err)
	}
	if got := re.snapshot(s.ID); got.State != StateConnected {
		t.Errorf("after the reconnect %+v", got)
	}
}

func TestRenderedMcpReconnect(t *testing.T) {
	re := newFixtureEnvAt(t, fixturePath("text-table"), []string{"CF_FAKE_CLAUDE_MCP=" + mcpFixture()})
	s := re.create(CreateOptions{})
	re.waitFor(s.ID, "idle", func(s Session) bool { return s.State == StateConnected && s.Status == StatusIdle })

	// No turn yet: the first read asks.
	first, err := re.m.McpStatus(re.ctx(), s.ID, false)
	if err != nil || first == nil || first.Trigger != McpTriggerRefresh || len(first.Servers) != 5 {
		t.Fatalf("first read = %+v, %v", first, err)
	}

	tests := []struct {
		name       string
		server     string
		wantErr    error
		wantResErr string // substring of the result's Error
		wantStatus string
		wantTools  int
	}{
		{name: "needs login, now connected", server: "claude.ai Gmail", wantStatus: McpConnected, wantTools: 23},
		{name: "still failing", server: "broken", wantResErr: "ENOENT", wantStatus: McpFailed},
		{name: "unknown server", server: "nope", wantErr: ErrNotFound},
		{name: "no name", server: " ", wantErr: ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := re.m.McpReconnect(re.ctx(), s.ID, tt.server)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if (tt.wantResErr == "") != (res.Error == "") || !strings.Contains(res.Error, tt.wantResErr) {
				t.Errorf("result error %q, want %q", res.Error, tt.wantResErr)
			}
			if res.Status == nil || res.Status.Trigger != McpTriggerReconnect || res.Status.Server != tt.server {
				t.Fatalf("status %+v", res.Status)
			}
			sv := serverOf(t, res.Status, tt.server)
			if sv.Status != tt.wantStatus || len(sv.Tools) != tt.wantTools {
				t.Errorf("server %+v", sv)
			}
			if re.items(s.ID).Mcp != res.Status {
				t.Error("not cached")
			}
			re.waitSent("mcp_reconnect "+tt.server, func(m map[string]any) bool {
				r, _ := m["request"].(map[string]any)
				return r["subtype"] == "mcp_reconnect" && r["serverName"] == tt.server
			})
		})
	}

	// An unknown thread has no MCP surface.
	if _, err := re.m.McpStatus(re.ctx(), "s-nope", false); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown thread status: %v", err)
	}
	if _, err := re.m.McpReconnect(re.ctx(), "s-nope", "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown thread reconnect: %v", err)
	}
}

func TestMcpUnsettledAndFill(t *testing.T) {
	init := []claudestream.McpServerInit{{Name: "docs", Status: "pending", Source: "claudeai"}, {Name: "gmail", Status: "needs-auth", Source: "claudeai"}}
	settled := &McpStatus{Servers: []McpServer{{Name: "docs", Status: McpConnected, Transport: "claudeai-proxy"}, {Name: "gmail", Status: McpNeedsAuth, Transport: "claudeai-proxy"}}}
	tests := []struct {
		name  string
		s     *McpStatus
		init  []claudestream.McpServerInit
		first bool
		want  bool
	}{
		{name: "settled", s: settled, init: init, want: false},
		{name: "a server pending", s: &McpStatus{Servers: []McpServer{{Name: "x", Status: McpPending, Transport: "stdio"}}}, want: true},
		{name: "none on the first check", s: &McpStatus{}, first: true, want: true},
		{name: "none later", s: &McpStatus{}, want: false},
		{name: "init lists one the answer lacks", s: &McpStatus{Servers: settled.Servers[:1]}, init: init, want: true},
		{name: "filled from init only", s: &McpStatus{Servers: fillFromInit(nil, init[1:])}, init: init[1:], want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := mcpUnsettled(tt.s, tt.init, tt.first); got != tt.want {
				t.Errorf("unsettled = %v", got)
			}
		})
	}
	got := fillFromInit([]McpServer{{Name: "docs", Status: McpConnected, Transport: "claudeai-proxy"}}, init)
	want := []McpServer{{Name: "docs", Status: McpConnected, Transport: "claudeai-proxy"}, {Name: "gmail", Status: McpNeedsAuth, Source: "claudeai", Scope: "claudeai"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("fill = %+v", got)
	}
}
