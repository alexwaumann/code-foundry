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

func newAgentsRegistry(t *testing.T) (*command.Registry, *threadtest.Fake, *commandtest.Emitter) {
	t.Helper()
	b := bus.New()
	fake := threadtest.New(b)
	reg := command.NewRegistry()
	emit := &commandtest.Emitter{Delivered: 1}
	if err := command.RegisterAgents(reg, api.NewThread(fake, b), api.NewSession(fake, b), emit); err != nil {
		t.Fatal(err)
	}
	fake.Put(thread.Session{ID: "s1", Name: "fix", State: thread.StateConnected})
	return reg, fake, emit
}

func TestAgentsCommandsAvailability(t *testing.T) {
	reg, _, _ := newAgentsRegistry(t)
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
		for _, name := range []string{"thread.agents", "view.panel.agents"} {
			c, _ := reg.Get(name)
			if got := c.Available(tt.ctx); got != tt.want {
				t.Errorf("%s %s: available = %v", tt.name, name, got)
			}
		}
	}
}

func TestThreadAgentsCommand(t *testing.T) {
	reg, fake, _ := newAgentsRegistry(t)
	fake.Put(thread.Session{ID: "s1", Name: "fix", State: thread.StateConnected, BackgroundShellsRunning: 2})
	start := time.Now().Add(-90 * time.Second)
	fake.PutAgents("s1",
		thread.AgentRun{ID: "a1", Description: "Slow count", AgentType: "general-purpose", Model: "haiku", Background: true, SpawnDepth: 1,
			Status: thread.AgentRunning, Activity: "Running Sleep 6 seconds", LastTool: "Bash", ToolUses: 1, TotalTokens: 14140, StartedAt: start},
		thread.AgentRun{ID: "a2", Description: "Outer agent", AgentType: "general-purpose", SpawnDepth: 1, Status: thread.AgentDone,
			Summary: "outer done\nmore", ToolUses: 2, TotalTokens: 18138, DurationMS: 5939, StartedAt: start},
	)
	res, err := reg.Invoke(context.Background(), command.Context{}, "thread.agents", map[string]string{"id": "s1"})
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range []string{
		"Agents: 1 running (1 in the background) · 2 this thread · 2 shells in the background\n",
		"NAME         TYPE             MODEL    MODE        STATUS   ELAPSED  TOOLS  TOKENS\n",
		"Slow count   general-purpose  haiku    background  running  1m 30s   1      14.1k\n",
		"Outer agent  general-purpose  inherit  foreground  done     5s       2      18.1k\n",
		"\nSlow count: Running Sleep 6 seconds (Bash)\nOuter agent: outer done",
	} {
		if !strings.Contains(res.Message, w) {
			t.Errorf("message lacks %q:\n%s", w, res.Message)
		}
	}
	if j, ok := res.JSON.(*v1.ThreadAgentsChange); !ok || j.GetSessionId() != "s1" || len(j.GetAgents()) != 2 {
		t.Errorf("json %+v", res.JSON)
	}
	_, err = reg.Invoke(context.Background(), command.Context{}, "thread.agents", map[string]string{"id": "nope"})
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeNotFound {
		t.Errorf("unknown thread: %v", err)
	}
}

func TestViewPanelAgentsEmits(t *testing.T) {
	reg, _, emit := newAgentsRegistry(t)
	res, err := reg.Invoke(context.Background(), command.Context{ActiveSessionID: "s1", ActiveView: "session"}, "view.panel.agents", nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Message != "" || res.JSON != (command.EmitResult{Delivered: 1}) {
		t.Errorf("result = %+v", res)
	}
	if got := emit.Intents(); len(got) != 1 || got[0].GetShowView().GetName() != command.ViewPanelAgents {
		t.Errorf("intents = %v", got)
	}
}

func TestFormatAgents(t *testing.T) {
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	at := func(d time.Duration) *timestamppb.Timestamp { return timestamppb.New(now.Add(-d)) }
	tests := []struct {
		name   string
		runs   []*v1.ThreadAgentRun
		shells int
		want   string
	}{
		{name: "none", want: "no subagent runs in this thread"},
		{name: "no runs, a shell", shells: 1, want: "no subagent runs in this thread · 1 shell in the background"},
		{
			name:   "a run and shells",
			runs:   []*v1.ThreadAgentRun{{Description: "Outer", AgentType: "general-purpose", SpawnDepth: 1, Status: v1.ThreadAgentStatus_THREAD_AGENT_STATUS_DONE, DurationMs: 4000}},
			shells: 3,
			want: "Agents: 0 running (0 in the background) · 1 this thread · 3 shells in the background\n" +
				"NAME   TYPE             MODEL    MODE        STATUS  ELAPSED  TOOLS  TOKENS\n" +
				"Outer  general-purpose  inherit  foreground  done    4s       -      -",
		},
		{
			name: "every state, nested, woken",
			runs: []*v1.ThreadAgentRun{
				{Description: "Slow count", AgentType: "general-purpose", Model: "haiku", Effort: "low", Background: true, SpawnDepth: 1,
					Status: v1.ThreadAgentStatus_THREAD_AGENT_STATUS_RUNNING, StartedAt: at(time.Hour), ResumedAt: at(12 * time.Second), ToolUses: 3, TotalTokens: 16137},
				{Description: "Outer", AgentType: "general-purpose", SpawnDepth: 1, Status: v1.ThreadAgentStatus_THREAD_AGENT_STATUS_DONE,
					StartedAt: at(2 * time.Hour), EndedAt: at(2*time.Hour - 65*time.Second), TotalTokens: 950},
				{Description: "Inner", SpawnDepth: 2, Status: v1.ThreadAgentStatus_THREAD_AGENT_STATUS_FAILED, Error: "stopped", DurationMs: 2*3600_000 + 5*60_000},
				{AgentType: "Explore", SpawnDepth: 3, Status: v1.ThreadAgentStatus_THREAD_AGENT_STATUS_UNSPECIFIED, TotalTokens: 1_250_000},
			},
			want: "Agents: 1 running (1 in the background) · 4 this thread\n" +
				"NAME         TYPE             MODEL      MODE        STATUS   ELAPSED  TOOLS  TOKENS\n" +
				"Slow count   general-purpose  haiku low  background  running  12s      3      16.1k\n" +
				"Outer        general-purpose  inherit    foreground  done     1m 05s   -      950\n" +
				"↳ Inner      -                inherit    foreground  failed   2h 05m   -      -\n" +
				"  ↳ Explore  Explore          inherit    foreground  unknown  -        -      1.2M\n" +
				"\n" +
				"Inner: error: stopped",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := command.FormatAgents(tt.runs, tt.shells, now); got != tt.want {
				t.Errorf("got\n%s\nwant\n%s", got, tt.want)
			}
		})
	}
}
