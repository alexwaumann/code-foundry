package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

func newThreadRegistry(t *testing.T) (*command.Registry, *threadtest.Fake) {
	t.Helper()
	b := bus.New()
	fake := threadtest.New(b)
	reg := command.NewRegistry()
	if err := command.RegisterThread(reg, api.NewThread(fake, b)); err != nil {
		t.Fatal(err)
	}
	fake.Put(thread.Thread{ID: "s1", Name: "fix", State: thread.StateConnected})
	return reg, fake
}

// A setting on a stopped thread only goes to its row; the message says when it applies.
func TestThreadSetEffortStopped(t *testing.T) {
	reg, fake := newThreadRegistry(t)
	fake.Put(thread.Thread{ID: "s2", Name: "idle", State: thread.StateDisconnected, DisconnectReason: thread.ReasonIdle})
	res, err := reg.Invoke(context.Background(), command.Context{}, "thread.set-effort", map[string]string{"id": "s2", "effort": "high"})
	if err != nil {
		t.Fatal(err)
	}
	if want := "thread idle (s2) uses effort high from its next message"; res.Message != want {
		t.Errorf("message %q, want %q", res.Message, want)
	}
}

func TestThreadCommandsAvailability(t *testing.T) {
	reg, _ := newThreadRegistry(t)
	tests := []struct {
		name string
		ctx  command.Context
		want bool
	}{
		{"cli", command.Context{ActiveThreadID: "s1"}, true},
		{"gui thread", command.Context{ActiveThreadID: "s1", ActiveView: "thread"}, true},
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

// Escape interrupted turns by accident; the composer's Interrupt button is the only way.
func TestThreadInterruptHasNoKeybinding(t *testing.T) {
	reg, _ := newThreadRegistry(t)
	c, _ := reg.Get("thread.interrupt")
	if len(c.Keybindings) != 0 {
		t.Errorf("thread.interrupt keybindings = %v, want none", c.Keybindings)
	}
}

func TestThreadCommands(t *testing.T) {
	question := `{"questions":[{"question":"Which color?","header":"Color","options":[{"label":"Red"},{"label":"Blue"}],"multiSelect":false}]}`
	tests := []struct {
		name      string
		items     []thread.Item
		cmd       string
		args      map[string]string
		wantErr   error
		wantMsg   string
		wantCalls []string
	}{
		{
			name: "send with the composer's text", cmd: "thread.send",
			args:    map[string]string{"id": "s1", "text": "/tdd go", "composer-text": "[/tdd](cf-skill://~/tdd) go"},
			wantMsg: "sent to thread s1 (#1); wait with: code-foundry thread wait s1 --after 1", wantCalls: []string{"Send s1 /tdd go composer=[/tdd](cf-skill://~/tdd) go"},
		},
		{
			name: "send", cmd: "thread.send", args: map[string]string{"id": "s1", "text": "go on", "attachments": "/a.png"},
			wantMsg: "sent to thread s1 (#1); wait with: code-foundry thread wait s1 --after 1", wantCalls: []string{"Send s1 go on attachments=/a.png"},
		},
		{
			name: "respond allows the oldest pending request", cmd: "thread.respond", args: map[string]string{"id": "s1"},
			items: []thread.Item{
				{ID: "perm-r1", Kind: thread.KindPermission, Request: &thread.Request{RequestID: "r1", ToolName: "Write", State: thread.RequestPending}},
				{ID: "perm-r2", Kind: thread.KindPermission, Request: &thread.Request{RequestID: "r2", ToolName: "Bash", State: thread.RequestPending}},
			},
			wantMsg: "Write: allowed (allow); 1 more pending: permission: Bash (request r2)", wantCalls: []string{"Respond s1 r1 allow"},
		},
		{
			name: "respond to a named request with deny", cmd: "thread.respond", args: map[string]string{"id": "s1", "decision": "deny", "request": "r2", "message": "no"},
			items: []thread.Item{
				{ID: "perm-r1", Kind: thread.KindPermission, Request: &thread.Request{RequestID: "r1", State: thread.RequestPending}},
				{ID: "perm-r2", Kind: thread.KindPermission, Request: &thread.Request{RequestID: "r2", State: thread.RequestPending}},
			},
			wantMsg: "denied (deny): no; 1 more pending: permission (request r1)", wantCalls: []string{"Respond s1 r2 deny"},
		},
		{
			name: "question with a bare label", cmd: "thread.respond", args: map[string]string{"id": "s1", "answer": "Blue"},
			items:   []thread.Item{{ID: "q-r1", Kind: thread.KindQuestion, Request: &thread.Request{RequestID: "r1", ToolName: "AskUserQuestion", InputJSON: question, State: thread.RequestPending}}},
			wantMsg: "answered \"Which color?\": Blue; nothing pending", wantCalls: []string{"Respond s1 r1 allow"},
		},
		{
			name: "question needs an answer", cmd: "thread.respond", args: map[string]string{"id": "s1"},
			items:   []thread.Item{{ID: "q-r1", Kind: thread.KindQuestion, Request: &thread.Request{RequestID: "r1", InputJSON: question, State: thread.RequestPending}}},
			wantErr: command.ErrInvalidArgs,
		},
		{
			name: "nothing pending", cmd: "thread.respond", args: map[string]string{"id": "s1"},
			wantMsg: "",
		},
		{
			name: "items", cmd: "thread.items", args: map[string]string{"id": "s1"},
			items: []thread.Item{
				{ID: "u", Kind: thread.KindUserMessage, Text: "write it", Attachments: []string{"/a.png", "/b.pdf"}},
				{ID: "t", Kind: thread.KindToolCall, Tool: &thread.ToolCall{Name: "Write", InputJSON: `{"file_path":"/x"}`, Status: thread.ToolDone, Output: "File created\nmore"}},
				{ID: "sub", Kind: thread.KindAssistantText, Text: "from the agent", ParentToolUseID: "t"},
				{ID: "p", Kind: thread.KindPermission, Request: &thread.Request{RequestID: "r9", ToolName: "Bash", Description: "ls", State: thread.RequestPending}},
				{ID: "a", Kind: thread.KindAssistantText, Text: "done"},
				{ID: "e", Kind: thread.KindTurnEnd, Turn: &thread.TurnEnd{Subtype: "success", DurationMS: 2500, CostUSD: 0.0123, OutputTokens: 9, InputTokens: 1}},
				{ID: "u2", Kind: thread.KindUserMessage, Text: "again"},
				{ID: "e2", Kind: thread.KindTurnEnd, Turn: &thread.TurnEnd{Subtype: "success", DurationMS: 1000, CostUSD: 0.0153, TurnCostUSD: new(0.003), Model: "claude-haiku-5-5"}},
				{ID: "n", Kind: thread.KindNote, Text: "Forked from fix"},
				{ID: "w", Kind: thread.KindUserMessage, Text: "[code-foundry wake] Thread s2 is idle: finished.\n```json\n{}\n```",
					Origin: thread.OriginWake, WakeTitle: "Thread s2 is idle: finished.", WakeJSON: "{}"},
				{ID: "turn-synth-w", Kind: thread.KindTurnEnd, Turn: &thread.TurnEnd{Subtype: thread.SubtypeProcessEnded, Interrupted: true, DurationMS: 9900}},
				{ID: "html-1", Kind: thread.KindHTML, HTML: &thread.HTMLPage{Path: "docs/a.html", Title: "Usage", BaseDir: "/wt"}},
			},
			wantMsg: "#1 you: write it\n    [image /a.png]\n    [pdf /b.pdf]\n#2 tool Write [done] {\"file_path\":\"/x\"}\n    → File created …\n    #3 claude: from the agent\n" +
				"#4 permission Bash ls: pending (request r9)\n#5 claude: done\n#6 turn end: success, 2.5s, 1 in / 9 out tokens, $0.0123 so far\n" +
				"#7 you: again\n#8 turn end: success, 1.0s, 0 in / 0 out tokens, $0.0030, $0.0153 so far, claude-haiku-5-5\n#9 note: Forked from fix\n" +
				"#10 wake: Thread s2 is idle: finished.\n#11 turn end: process_ended, 9.9s, 0 in / 0 out tokens (interrupted)\n#12 page: docs/a.html (Usage)",
		},
		{
			// orch-child-context: the resume note Claude got shows under the message.
			name: "a message with a resume note", cmd: "thread.items", args: map[string]string{"id": "s1"},
			items: []thread.Item{{ID: "u", Kind: thread.KindUserMessage, Text: "continue",
				ResumeNote: "[code-foundry] Your previous turn was stopped at the spending limit."}},
			wantMsg: "#1 you: continue\n    [code-foundry] Your previous turn was stopped at the spending limit.",
		},
		{
			// E7: read --full cut a wake to its title.
			name: "full prints a wake's JSON", cmd: "thread.items", args: map[string]string{"id": "s1", "full": "true"},
			items: []thread.Item{{ID: "w", Kind: thread.KindUserMessage, Text: "[code-foundry wake] Thread s2 is idle.\n```json\n{\n  \"kind\": \"thread\"\n}\n```",
				Origin: thread.OriginWake, WakeTitle: "Thread s2 is idle.", WakeJSON: "{\n  \"kind\": \"thread\"\n}"}},
			wantMsg: "#1 wake: Thread s2 is idle.\n{\n  \"kind\": \"thread\"\n}",
		},
		{
			name: "set mode", cmd: "thread.set-mode", args: map[string]string{"id": "s1", "permission": "accept-edits"},
			wantMsg: "thread fix (s1) runs accept-edits", wantCalls: []string{"SetPermissionMode s1 2"},
		},
		{
			name: "set model", cmd: "thread.set-model", args: map[string]string{"id": "s1", "model": "claude-sonnet-5[1m]"},
			wantMsg: "thread fix (s1) uses Sonnet 5", wantCalls: []string{"SetModel s1 claude-sonnet-5[1m]"},
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

// thread.respond from the CLI names the request Claude asks next, a few ms after the
// answer (parallel tool calls are asked one after the other; w2a finding 2). The GUI
// (a view in its context) does not wait for it.
func TestThreadRespondNamesTheNextRequest(t *testing.T) {
	first := thread.Item{ID: "perm-r1", Kind: thread.KindPermission, Request: &thread.Request{RequestID: "r1", ToolName: "Edit", Description: "README.md", State: thread.RequestPending}}
	tests := []struct {
		name string
		uctx command.Context
		want string
	}{
		{name: "cli", want: "Edit README.md: allowed (allow); 1 more pending: permission: Bash rm -r docs (request r2)"},
		{name: "gui", uctx: command.Context{ActiveView: "thread", ActiveThreadID: "s1"}, want: "Edit README.md: allowed (allow); nothing pending"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newThreadRegistry(t)
			fake.Put(thread.Thread{ID: "s1", Name: "fix", State: thread.StateConnected, Status: thread.StatusNeedsAttention, StatusReason: "permission: Edit README.md"})
			fake.PutItems("s1", first)
			// Claude asks the next one once the first is answered.
			go func() {
				for !strings.Contains(strings.Join(fake.Calls(), "|"), "Respond s1 r1") {
					time.Sleep(time.Millisecond)
				}
				time.Sleep(20 * time.Millisecond)
				answered := first
				r := *first.Request
				r.State = thread.RequestAllowed
				answered.Request = &r
				fake.PutItems("s1", answered,
					thread.Item{ID: "perm-r2", Kind: thread.KindPermission, Request: &thread.Request{RequestID: "r2", ToolName: "Bash", Description: "rm -r docs", State: thread.RequestPending}})
			}()
			res, err := reg.Invoke(context.Background(), tt.uctx, "thread.respond", map[string]string{"id": "s1"})
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.want {
				t.Errorf("message %q, want %q", res.Message, tt.want)
			}
		})
	}
}
