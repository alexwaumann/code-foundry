package command_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/presence"
)

func TestUIPresence(t *testing.T) {
	const self, other = "s-aaaaaaaaaaa1", "s-bbbbbbbbbbb2"
	viewed := map[string]bool{self: true}
	deps := func(st presence.State, windows int) command.PresenceDeps {
		return command.PresenceDeps{
			Presence: func() presence.State { return st },
			Windows:  func() int { return windows },
			Viewed:   func(id string) bool { return viewed[id] },
		}
	}
	attended := presence.State{Kind: presence.Foreground, Attended: true}
	tests := []struct {
		name     string
		deps     command.PresenceDeps
		ctx      command.Context
		args     map[string]string
		wantJSON string
		wantText string
	}{
		{
			name: "in a thread the user is looking at", deps: deps(attended, 1), ctx: command.Context{ActiveThreadID: self},
			wantJSON: `{"state":"foreground+attended","attended":true,"windows":1,"thread":"s-aaaaaaaaaaa1","viewed":true}`,
			wantText: "presence: foreground+attended (the user is looking at the app)\nwindows: 1\nthread s-aaaaaaaaaaa1: viewed (a window shows it)",
		},
		{
			name: "--thread names another, not shown", deps: deps(attended, 2), ctx: command.Context{ActiveThreadID: self}, args: map[string]string{"thread": other},
			wantJSON: `{"state":"foreground+attended","attended":true,"windows":2,"thread":"s-bbbbbbbbbbb2","viewed":false}`,
			wantText: "presence: foreground+attended (the user is looking at the app)\nwindows: 2\nthread s-bbbbbbbbbbb2: not viewed (no window shows it)",
		},
		{
			name: "visible behind another app", deps: deps(presence.State{Kind: presence.Foreground}, 1), ctx: command.Context{ActiveThreadID: self},
			wantJSON: `{"state":"foreground","attended":false,"windows":1,"thread":"s-aaaaaaaaaaa1","viewed":true}`,
			wantText: "presence: foreground (an app window is visible, another app is in front)\nwindows: 1\nthread s-aaaaaaaaaaa1: viewed (a window shows it)",
		},
		{
			name: "minimized", deps: deps(presence.State{Kind: presence.Background}, 1), ctx: command.Context{ActiveThreadID: other},
			wantJSON: `{"state":"background","attended":false,"windows":1,"thread":"s-bbbbbbbbbbb2","viewed":false}`,
			wantText: "presence: background (the app's windows are hidden or minimized)\nwindows: 1\nthread s-bbbbbbbbbbb2: not viewed (no window shows it)",
		},
		{
			name: "no GUI, outside a thread", deps: deps(presence.State{}, 0),
			wantJSON: `{"state":"none","attended":false,"windows":0,"viewed":false}`,
			wantText: "presence: none (no app window is open)\nwindows: 0",
		},
		{
			name: "no deps", deps: command.PresenceDeps{}, ctx: command.Context{ActiveThreadID: self},
			wantJSON: `{"state":"none","attended":false,"windows":0,"thread":"s-aaaaaaaaaaa1","viewed":false}`,
			wantText: "presence: none (no app window is open)\nwindows: 0\nthread s-aaaaaaaaaaa1: not viewed (no window shows it)",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			if err := command.RegisterPresence(reg, tt.deps); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), tt.ctx, "ui.presence", tt.args)
			if err != nil {
				t.Fatal(err)
			}
			b, err := json.Marshal(res.JSON)
			if err != nil {
				t.Fatal(err)
			}
			if string(b) != tt.wantJSON {
				t.Errorf("JSON\n got %s\nwant %s", b, tt.wantJSON)
			}
			if res.Message != tt.wantText {
				t.Errorf("text\n got %q\nwant %q", res.Message, tt.wantText)
			}
		})
	}
}
