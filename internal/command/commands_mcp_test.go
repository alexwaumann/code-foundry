package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

func newMcpRegistry(t *testing.T) (*command.Registry, *threadtest.Fake, *commandtest.Emitter) {
	t.Helper()
	b := bus.New()
	fake := threadtest.New(b)
	reg := command.NewRegistry()
	emit := &commandtest.Emitter{Delivered: 1}
	if err := command.RegisterMcp(reg, api.NewThread(fake, b), emit); err != nil {
		t.Fatal(err)
	}
	fake.Put(thread.Session{ID: "s1", Name: "fix", State: thread.StateConnected})
	fake.PutMcp("s1", &thread.McpStatus{CheckedAt: time.Now().Add(-12 * time.Second), Trigger: thread.McpTriggerTurn, Servers: []thread.McpServer{
		{Name: "github", Status: thread.McpConnected, Version: "1.12.0", Scope: "user", Transport: "stdio",
			Tools: []thread.McpTool{{Name: "get_pull_request", Description: "Get details of a pull request", ReadOnly: true}, {Name: "merge_pull_request", Destructive: true, OpenWorld: true}}},
		{Name: "linear", Status: thread.McpNeedsAuth, Scope: "user", Transport: "http"},
		{Name: "playwright", Status: thread.McpFailed, Error: "spawn npx ENOENT", Scope: "project", Transport: "stdio"},
	}})
	return reg, fake, emit
}

func TestMcpCommandsAvailability(t *testing.T) {
	reg, _, _ := newMcpRegistry(t)
	tests := []struct {
		name string
		ctx  command.Context
		want bool
	}{
		{"cli", command.Context{ActiveSessionID: "s1"}, true},
		{"gui thread", command.Context{ActiveSessionID: "s1", ActiveView: "session"}, true},
		{"no thread", command.Context{ActiveView: "projects"}, false},
	}
	for _, tt := range tests {
		for _, name := range []string{"thread.mcp", "thread.mcp-reconnect", "view.panel.mcp"} {
			c, _ := reg.Get(name)
			if got := c.Available(tt.ctx); got != tt.want {
				t.Errorf("%s %s: available = %v", tt.name, name, got)
			}
		}
	}
}

func TestMcpCommands(t *testing.T) {
	tests := []struct {
		name      string
		cmd       string
		args      map[string]string
		reconnErr string
		wantErr   connect.Code
		wantMsg   []string
		notMsg    []string
		wantCalls []string
	}{
		{
			name: "table", cmd: "thread.mcp", args: map[string]string{"id": "s1"},
			wantMsg: []string{
				"MCP servers: 1 of 3 connected (checked 12s ago, at the start of the last turn)",
				"SERVER", "github      connected", "1.12.0", "linear      needs login", "playwright  failed",
				"error: spawn npx ENOENT", "needs login: run claude in a shell and log in with /mcp, then thread mcp-reconnect --server 'linear'",
			},
			notMsg:    []string{"get_pull_request"},
			wantCalls: []string{"McpStatus s1"},
		},
		{
			name: "full", cmd: "thread.mcp", args: map[string]string{"id": "s1", "full": "true", "refresh": "true"},
			wantMsg:   []string{"(checked just now)\n", "get_pull_request    read-only                        Get details of a pull request\n", "merge_pull_request  writes, destructive, open-world\n"},
			wantCalls: []string{"McpStatus s1 refresh"},
		},
		{
			name: "reconnect", cmd: "thread.mcp-reconnect", args: map[string]string{"id": "s1", "server": "playwright"},
			wantMsg: []string{"reconnected playwright: connected"}, wantCalls: []string{"McpReconnect s1 playwright"},
		},
		{
			name: "reconnect still failing", cmd: "thread.mcp-reconnect", args: map[string]string{"id": "s1", "server": "linear"}, reconnErr: "needs login",
			wantMsg: []string{"reconnect linear failed: needs login (needs login)"}, wantCalls: []string{"McpReconnect s1 linear"},
		},
		{
			name: "unknown server", cmd: "thread.mcp-reconnect", args: map[string]string{"id": "s1", "server": "nope"},
			wantErr: connect.CodeNotFound, wantCalls: []string{"McpReconnect s1 nope"},
		},
		{
			name: "unknown thread", cmd: "thread.mcp", args: map[string]string{"id": "nope"},
			wantErr: connect.CodeNotFound, wantCalls: []string{"McpStatus nope"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake, _ := newMcpRegistry(t)
			if tt.reconnErr != "" {
				fake.SetMcpReconnectError(tt.args["server"], tt.reconnErr)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, tt.cmd, tt.args)
			if tt.wantErr != 0 {
				var ce *connect.Error
				if !errors.As(err, &ce) || ce.Code() != tt.wantErr {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			for _, w := range tt.wantMsg {
				if !strings.Contains(res.Message, w) {
					t.Errorf("message lacks %q:\n%s", w, res.Message)
				}
			}
			for _, w := range tt.notMsg {
				if strings.Contains(res.Message, w) {
					t.Errorf("message has %q:\n%s", w, res.Message)
				}
			}
			if got := fake.Calls(); strings.Join(got, "|") != strings.Join(tt.wantCalls, "|") {
				t.Errorf("calls = %q, want %q", got, tt.wantCalls)
			}
		})
	}
}

func TestViewPanelMcpEmits(t *testing.T) {
	reg, _, emit := newMcpRegistry(t)
	uctx := command.Context{ActiveSessionID: "s1", ActiveView: "session"}
	res, err := reg.Invoke(context.Background(), uctx, "view.panel.mcp", nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Message != "" || res.JSON != (command.EmitResult{Delivered: 1}) {
		t.Errorf("result = %+v", res)
	}
	if got := emit.Intents(); len(got) != 1 || got[0].GetShowView().GetName() != command.ViewPanelMcp {
		t.Errorf("intents = %v", got)
	}
}

func TestFormatMcpStatus(t *testing.T) {
	now := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	at := func(d time.Duration) *timestamppb.Timestamp { return timestamppb.New(now.Add(-d)) }
	tests := []struct {
		name string
		st   *v1.ThreadMcpStatus
		want string
	}{
		{name: "never reported", st: nil, want: "no MCP status yet: Claude has not reported this thread's MCP servers"},
		{name: "no servers", st: &v1.ThreadMcpStatus{CheckedAt: at(3 * time.Second), Trigger: v1.McpCheckTrigger_MCP_CHECK_TRIGGER_REFRESH},
			want: "no MCP servers (checked just now)"},
		{name: "after a reconnect", st: &v1.ThreadMcpStatus{CheckedAt: at(5 * time.Minute), Trigger: v1.McpCheckTrigger_MCP_CHECK_TRIGGER_RECONNECT, Server: "a",
			Servers: []*v1.McpServer{{Name: "a", Status: v1.McpServerStatus_MCP_SERVER_STATUS_PENDING}, {Name: "b", Status: v1.McpServerStatus_MCP_SERVER_STATUS_DISABLED}}},
			want: "MCP servers: 0 of 2 connected (checked 5 min ago, after reconnecting a)\n" +
				"SERVER  STATUS      SCOPE  TRANSPORT  VERSION  TOOLS\n" +
				"a       connecting  -      -          -        -\n" +
				"b       disabled    -      -          -        -"},
		{name: "hours, unknown status", st: &v1.ThreadMcpStatus{CheckedAt: at(2 * time.Hour), Trigger: v1.McpCheckTrigger_MCP_CHECK_TRIGGER_TURN_START,
			Servers: []*v1.McpServer{{Name: "x", Scope: "user", Transport: "sdk"}}},
			want: "MCP servers: 0 of 1 connected (checked 2 h ago, at the start of the last turn)\n" +
				"SERVER  STATUS   SCOPE  TRANSPORT  VERSION  TOOLS\n" +
				"x       unknown  user   sdk        -        -"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := command.FormatMcpStatus(tt.st, false, now); got != tt.want {
				t.Errorf("got\n%s\nwant\n%s", got, tt.want)
			}
		})
	}
}
