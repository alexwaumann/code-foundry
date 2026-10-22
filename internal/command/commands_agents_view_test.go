package command_test

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestAgentViewCommandsAvailability(t *testing.T) {
	reg, _, _ := newAgentsRegistry(t)
	tests := []struct {
		name     string
		ctx      command.Context
		open, up bool
	}{
		{"cli", command.Context{}, false, true},
		{"cli with a thread", command.Context{ActiveThreadID: "s1"}, true, true},
		{"gui thread", command.Context{ActiveThreadID: "s1", ActiveView: "thread"}, true, false},
		{"gui subagent view", command.Context{ActiveThreadID: "s1", ActiveView: command.ViewSubagent}, true, true},
		{"gui page", command.Context{ActiveView: "projects"}, false, false},
	}
	for _, tt := range tests {
		for name, want := range map[string]bool{"thread.agent.open": tt.open, "thread.agent.up": tt.up} {
			c, ok := reg.Get(name)
			if !ok {
				t.Fatalf("%s not registered", name)
			}
			if got := c.Available(tt.ctx); got != want {
				t.Errorf("%s %s: available = %v, want %v", tt.name, name, got, want)
			}
		}
	}
}

func TestAgentViewKeybindings(t *testing.T) {
	reg, _, _ := newAgentsRegistry(t)
	open, _ := reg.Get("thread.agent.open")
	if !open.NoKeybinding || len(open.Keybindings) != 0 {
		t.Errorf("thread.agent.open: NoKeybinding %v, keybindings %v", open.NoKeybinding, open.Keybindings)
	}
	up, _ := reg.Get("thread.agent.up")
	if len(up.Keybindings) != 1 || up.Keybindings[0] != "escape" {
		t.Errorf("thread.agent.up keybindings = %v, want [escape]", up.Keybindings)
	}
}

func TestThreadAgentOpen(t *testing.T) {
	reg, fake, emit := newAgentsRegistry(t)
	fake.PutAgents("s1",
		thread.AgentRun{ID: "a7f30c1d", ToolUseID: "toolu_1", Description: "PR 1", SpawnDepth: 1, Status: thread.AgentRunning},
		thread.AgentRun{ID: "a7f39e02", ToolUseID: "toolu_2", Description: "PR 2", SpawnDepth: 1, Status: thread.AgentDone},
		thread.AgentRun{ID: "b1c2", ToolUseID: "toolu_3", ParentID: "a7f30c1d", Description: "Review", SpawnDepth: 2, Status: thread.AgentRunning},
	)
	tests := []struct {
		name    string
		run     string
		want    string
		errCode connect.Code
	}{
		{name: "exact", run: "a7f30c1d", want: "a7f30c1d"},
		{name: "unique start", run: "a7f39", want: "a7f39e02"},
		{name: "ambiguous start", run: "a7f3", errCode: connect.CodeInvalidArgument},
		{name: "unknown", run: "zz", errCode: connect.CodeNotFound},
		{name: "nested run", run: "b1c2", errCode: connect.CodeFailedPrecondition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := len(emit.Intents())
			res, err := reg.Invoke(context.Background(), command.Context{}, "thread.agent.open", map[string]string{"id": "s1", "run": tt.run})
			if tt.errCode != 0 {
				var ce *connect.Error
				if !errors.As(err, &ce) || ce.Code() != tt.errCode {
					t.Fatalf("err = %v, want code %v", err, tt.errCode)
				}
				if len(emit.Intents()) != before {
					t.Errorf("emitted on error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != "windows=1" || res.JSON != (command.EmitResult{Windows: 1, Receivers: 1}) {
				t.Errorf("result = %+v", res)
			}
			got := emit.Intents()
			if len(got) != before+1 {
				t.Fatalf("intents = %v", got)
			}
			show := got[len(got)-1].GetShowAgentRun()
			if show.GetThreadId() != "s1" || show.GetRunId() != tt.want {
				t.Errorf("intent = %v, want s1/%s", show, tt.want)
			}
		})
	}
	_, err := reg.Invoke(context.Background(), command.Context{}, "thread.agent.open", map[string]string{"id": "nope", "run": "a7f30c1d"})
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeNotFound {
		t.Errorf("unknown thread: %v", err)
	}
}

func TestThreadAgentUpEmits(t *testing.T) {
	reg, _, emit := newAgentsRegistry(t)
	res, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s1", ActiveView: command.ViewSubagent}, "thread.agent.up", nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Message != "" || res.JSON != (command.EmitResult{Windows: 1, Receivers: 1}) {
		t.Errorf("result = %+v", res)
	}
	if got := emit.Intents(); len(got) != 1 || got[0].GetShowView().GetName() != command.ViewAgentUp {
		t.Errorf("intents = %v", got)
	}
	if _, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s1", ActiveView: "thread"}, "thread.agent.up", nil); !errors.Is(err, command.ErrUnavailable) {
		t.Errorf("on a thread page: err = %v, want unavailable", err)
	}
}
