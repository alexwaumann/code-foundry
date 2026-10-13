package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/session"
	"github.com/alexwaumann/code-foundry/internal/store/session/sessiontest"
)

func newThreadRegistry(t *testing.T) (*command.Registry, *sessiontest.Fake) {
	t.Helper()
	b := bus.New()
	fake := sessiontest.New(b)
	reg := command.NewRegistry()
	if err := command.RegisterThread(reg, api.NewThread(fake, b)); err != nil {
		t.Fatal(err)
	}
	fake.Put(session.Session{ID: "s1", Name: "fix", State: session.StateConnected})
	return reg, fake
}

func TestThreadCommandsAvailability(t *testing.T) {
	reg, _ := newThreadRegistry(t)
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
		for _, name := range []string{"thread.send", "thread.respond", "thread.interrupt", "thread.items", "thread.set-model", "thread.set-mode", "thread.set-effort"} {
			c, _ := reg.Get(name)
			if got := c.Available(tt.ctx); got != tt.want {
				t.Errorf("%s %s: available = %v", tt.name, name, got)
			}
		}
	}
}

func TestThreadCommands(t *testing.T) {
	question := `{"questions":[{"question":"Which color?","header":"Color","options":[{"label":"Red"},{"label":"Blue"}],"multiSelect":false}]}`
	tests := []struct {
		name      string
		items     []session.Item
		cmd       string
		args      map[string]string
		wantErr   error
		wantMsg   string
		wantCalls []string
	}{
		{
			name: "send with the composer's text", cmd: "thread.send",
			args:    map[string]string{"id": "s1", "text": "/tdd go", "composer-text": "[/tdd](cf-skill://~/tdd) go"},
			wantMsg: "sent to thread s1", wantCalls: []string{"Send s1 /tdd go composer=[/tdd](cf-skill://~/tdd) go"},
		},
		{
			name: "send", cmd: "thread.send", args: map[string]string{"id": "s1", "text": "go on", "attachments": "/a.png"},
			wantMsg: "sent to thread s1", wantCalls: []string{"Send s1 go on attachments=/a.png"},
		},
		{
			name: "respond allows the oldest pending request", cmd: "thread.respond", args: map[string]string{"id": "s1"},
			items: []session.Item{
				{ID: "perm-r1", Kind: session.KindPermission, Request: &session.Request{RequestID: "r1", ToolName: "Write", State: session.RequestPending}},
				{ID: "perm-r2", Kind: session.KindPermission, Request: &session.Request{RequestID: "r2", ToolName: "Bash", State: session.RequestPending}},
			},
			wantMsg: "allowed (allow)", wantCalls: []string{"Respond s1 r1 allow"},
		},
		{
			name: "respond to a named request with deny", cmd: "thread.respond", args: map[string]string{"id": "s1", "decision": "deny", "request": "r2", "message": "no"},
			items: []session.Item{
				{ID: "perm-r1", Kind: session.KindPermission, Request: &session.Request{RequestID: "r1", State: session.RequestPending}},
				{ID: "perm-r2", Kind: session.KindPermission, Request: &session.Request{RequestID: "r2", State: session.RequestPending}},
			},
			wantMsg: "denied (deny): no", wantCalls: []string{"Respond s1 r2 deny"},
		},
		{
			name: "question with a bare label", cmd: "thread.respond", args: map[string]string{"id": "s1", "answer": "Blue"},
			items:   []session.Item{{ID: "q-r1", Kind: session.KindQuestion, Request: &session.Request{RequestID: "r1", ToolName: "AskUserQuestion", InputJSON: question, State: session.RequestPending}}},
			wantMsg: "allowed (allow): Which color? = Blue", wantCalls: []string{"Respond s1 r1 allow"},
		},
		{
			name: "question needs an answer", cmd: "thread.respond", args: map[string]string{"id": "s1"},
			items:   []session.Item{{ID: "q-r1", Kind: session.KindQuestion, Request: &session.Request{RequestID: "r1", InputJSON: question, State: session.RequestPending}}},
			wantErr: command.ErrInvalidArgs,
		},
		{
			name: "nothing pending", cmd: "thread.respond", args: map[string]string{"id": "s1"},
			wantMsg: "",
		},
		{
			name: "items", cmd: "thread.items", args: map[string]string{"id": "s1"},
			items: []session.Item{
				{ID: "u", Kind: session.KindUserMessage, Text: "write it", Attachments: []string{"/a.png"}},
				{ID: "t", Kind: session.KindToolCall, Tool: &session.ToolCall{Name: "Write", InputJSON: `{"file_path":"/x"}`, Status: session.ToolDone, Output: "File created\nmore"}},
				{ID: "sub", Kind: session.KindAssistantText, Text: "from the agent", ParentToolUseID: "t"},
				{ID: "p", Kind: session.KindPermission, Request: &session.Request{RequestID: "r9", ToolName: "Bash", Description: "ls", State: session.RequestPending}},
				{ID: "a", Kind: session.KindAssistantText, Text: "done"},
				{ID: "e", Kind: session.KindTurnEnd, Turn: &session.TurnEnd{Subtype: "success", DurationMS: 2500, CostUSD: 0.0123, OutputTokens: 9, InputTokens: 1}},
				{ID: "u2", Kind: session.KindUserMessage, Text: "again"},
				{ID: "e2", Kind: session.KindTurnEnd, Turn: &session.TurnEnd{Subtype: "success", DurationMS: 1000, CostUSD: 0.0153, TurnCostUSD: new(0.003), Model: "claude-haiku-5-5"}},
				{ID: "n", Kind: session.KindNote, Text: "Forked from fix"},
			},
			wantMsg: "#1 you: write it\n    [image /a.png]\n#2 tool Write [done] {\"file_path\":\"/x\"}\n    → File created …\n    #3 claude: from the agent\n" +
				"#4 permission Bash ls: pending (request r9)\n#5 claude: done\n#6 turn end: success, 2.5s, 1 in / 9 out tokens, $0.0123 so far\n" +
				"#7 you: again\n#8 turn end: success, 1.0s, 0 in / 0 out tokens, $0.0030, $0.0153 so far, claude-haiku-5-5\n#9 note: Forked from fix",
		},
		{
			name: "set mode", cmd: "thread.set-mode", args: map[string]string{"id": "s1", "permission": "accept-edits"},
			wantMsg: "thread fix (s1) runs accept-edits", wantCalls: []string{"SetPermissionMode s1 2"},
		},
		{
			name: "set model", cmd: "thread.set-model", args: map[string]string{"id": "s1", "model": "sonnet"},
			wantMsg: "thread fix (s1) uses sonnet", wantCalls: []string{"SetModel s1 sonnet"},
		},
		{
			name: "set effort", cmd: "thread.set-effort", args: map[string]string{"id": "s1", "effort": "high"},
			wantMsg: "thread fix (s1) restarts with effort high", wantCalls: []string{"SetEffort s1 high"},
		},
		{
			name: "bad effort", cmd: "thread.set-effort", args: map[string]string{"id": "s1", "effort": "huge"},
			wantErr: command.ErrInvalidArgs,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newThreadRegistry(t)
			fake.PutItems("s1", tt.items...)
			res, err := reg.Invoke(context.Background(), command.Context{}, tt.cmd, tt.args)
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			case tt.name == "nothing pending":
				if err == nil || !strings.Contains(err.Error(), "no pending request") {
					t.Fatalf("err = %v", err)
				}
				return
			case err != nil:
				t.Fatal(err)
			}
			if !strings.Contains(res.Message, tt.wantMsg) {
				t.Errorf("message\n%s\nwant it to contain\n%s", res.Message, tt.wantMsg)
			}
			if calls := fake.Calls(); strings.Join(calls, "|") != strings.Join(tt.wantCalls, "|") {
				t.Errorf("calls %q, want %q", calls, tt.wantCalls)
			}
		})
	}
}
