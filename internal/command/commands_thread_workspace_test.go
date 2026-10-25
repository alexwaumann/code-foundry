package command_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// TestThreadWorkspaceAndNewLike covers thread.workspace (set or clear a thread's
// workspace reference) and thread.new-like ("New thread on this branch").
func TestThreadWorkspaceAndNewLike(t *testing.T) {
	auto := v1.PermissionMode_PERMISSION_MODE_AUTO
	tests := []struct {
		name      string
		cmd       string
		ctx       command.Context
		args      map[string]string
		current   *v1.Thread
		hints     []string
		wantErr   error
		wantMsg   string
		wantReqs  []proto.Message
		wantWarns []string
		wantFocus bool
	}{
		{name: "workspace: set on the context thread", cmd: "thread.workspace", ctx: command.Context{ActiveThreadID: "s-c"},
			args: map[string]string{"workspace": "shop"}, current: &v1.Thread{Name: "fix"},
			wantMsg:  "thread fix (s-c) now references workspace shop; it applies from the thread's next start",
			wantReqs: []proto.Message{&v1.SetThreadWorkspaceRequest{Id: "s-c", Workspace: "shop"}}},
		{name: "workspace: clear by id", cmd: "thread.workspace", args: map[string]string{"id": "s-c"},
			wantMsg:  "thread s-c references no workspace; it applies from the thread's next start",
			wantReqs: []proto.Message{&v1.SetThreadWorkspaceRequest{Id: "s-c"}}},
		{name: "workspace: no thread in the GUI", cmd: "thread.workspace", ctx: command.Context{ActiveView: "dashboard"}, args: map[string]string{"workspace": "shop"}, wantErr: command.ErrUnavailable},

		{name: "new-like: the context thread, only a prompt", cmd: "thread.new-like", ctx: command.Context{ActiveThreadID: "s-src", ActiveView: "thread", ActiveProjectID: "web"},
			args:      map[string]string{"prompt": "next step"},
			wantMsg:   "created thread s1 in  (no project)", // the fake's thread has none, as a like of a no-project thread
			wantReqs:  []proto.Message{&v1.CreateThreadRequest{LikeThreadId: "s-src", InitialPrompt: "next step", PermissionMode: auto}},
			wantFocus: true},
		{name: "new-like: another primary and the composer's options", cmd: "thread.new-like",
			args: map[string]string{"id": "s-src", "project": "api", "model": "claude-opus-4-8[1m]", "effort": "low", "permission": "supervised",
				"prompt": "p", "composer-prompt": "p [/x](cf-skill://x)", "attachments": "/a/1.png, /a/2.pdf", "name": "n", "focus": "false"},
			hints:   []string{"web @ feat/x is also open in fix (s-src)"},
			wantMsg: "created thread n (s1) in ",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{LikeThreadId: "s-src", ProjectId: "api", Model: "claude-opus-4-8[1m]", Effort: "low",
				PermissionMode: v1.PermissionMode_PERMISSION_MODE_SUPERVISED, InitialPrompt: "p", ComposerPrompt: "p [/x](cf-skill://x)",
				Attachments: []string{"/a/1.png", "/a/2.pdf"}, Name: "n"}},
			wantWarns: []string{"web @ feat/x is also open in fix (s-src)"}},
		{name: "new-like: no thread in the GUI", cmd: "thread.new-like", ctx: command.Context{ActiveView: "dashboard"}, args: map[string]string{"prompt": "p"}, wantErr: command.ErrUnavailable},
		{name: "new-like: a thread without a project in the GUI", cmd: "thread.new-like", ctx: command.Context{ActiveThreadID: "s-src", ActiveView: "thread"},
			args: map[string]string{"prompt": "p"}, wantErr: command.ErrUnavailable},
		{name: "new-like: a thread in its workspace's folder in the GUI", cmd: "thread.new-like", ctx: command.Context{ActiveThreadID: "s-src", ActiveView: "thread", ActiveWorkspaceID: "w-1"},
			args: map[string]string{"prompt": "p", "focus": "false"}, wantMsg: "created thread s1 in  (no project)",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{LikeThreadId: "s-src", InitialPrompt: "p", PermissionMode: auto}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, e := newLifecycleRegistry(t)
			b.Current, b.Hints = tt.current, tt.hints
			res, err := reg.Invoke(context.Background(), tt.ctx, tt.cmd, tt.args)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				if len(b.Requests()) != 0 {
					t.Errorf("requests = %v, want none", b.Requests())
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if got := b.Requests(); !slices.EqualFunc(got, tt.wantReqs, proto.Equal) {
				t.Errorf("requests = %v, want %v", got, tt.wantReqs)
			}
			if !slices.Equal(res.Warnings, tt.wantWarns) {
				t.Errorf("warnings = %q, want %q", res.Warnings, tt.wantWarns)
			}
			if got := len(e.Intents()) > 0; got != tt.wantFocus {
				t.Errorf("focus intent = %v, want %v", got, tt.wantFocus)
			}
		})
	}
}
