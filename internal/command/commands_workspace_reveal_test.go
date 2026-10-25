package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
	"github.com/alexwaumann/code-foundry/internal/store/workspace/workspacetest"
)

func TestWorkspaceReveal(t *testing.T) {
	tests := []struct {
		name     string
		ctx      command.Context
		args     map[string]string
		want     string // the path revealed
		wantCode connect.Code
		wantErr  error
	}{
		{name: "a synthetic workspace: its managed dir", args: map[string]string{"workspace": "shop"}, want: "/workspaces/w-1"},
		{name: "a rooted one by name in any case: its root", args: map[string]string{"workspace": "MONO"}, want: "/Users/me/mono"},
		{name: "the active workspace", ctx: command.Context{ActiveWorkspaceID: "w-2", ActiveView: "thread"}, want: "/Users/me/mono"},
		{name: "unknown", args: map[string]string{"workspace": "nope"}, wantCode: connect.CodeNotFound},
		{name: "none named", wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := bus.New()
			fake := workspacetest.New(b)
			ctx := context.Background()
			if _, err := fake.Create(ctx, workspace.CreateOptions{Name: "shop", Members: []string{"web"}}); err != nil {
				t.Fatal(err)
			}
			if _, err := fake.Create(ctx, workspace.CreateOptions{Name: "mono", RootPath: "/Users/me/mono"}); err != nil {
				t.Fatal(err)
			}
			var revealed []string
			reg := command.NewRegistry()
			if err := command.RegisterWorkspaceReveal(reg, api.NewWorkspace(fake, b), func(_ context.Context, p string) error {
				revealed = append(revealed, p)
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			_, err := reg.Invoke(ctx, tt.ctx, "workspace.reveal", tt.args)
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
				return
			case err != nil:
				t.Fatal(err)
			}
			if len(revealed) != 1 || revealed[0] != tt.want {
				t.Fatalf("revealed %v, want [%s]", revealed, tt.want)
			}
		})
	}
}

// workspace.remove's confirm says what goes: a synthetic workspace's instructions and
// skills, a rooted one's links only.
func TestWorkspaceRemoveConfirm(t *testing.T) {
	tests := []struct {
		ref, want string
	}{
		{ref: "shop", want: "Remove workspace shop? Its instructions and skills are deleted too."},
		{ref: "mono", want: "Its root folder /Users/me/mono and everything in it stay"},
	}
	for _, tt := range tests {
		t.Run(tt.ref, func(t *testing.T) {
			reg, fake := newWorkspaceRegistry(t)
			ctx := context.Background()
			if _, err := fake.Create(ctx, workspace.CreateOptions{Name: "shop", Members: []string{"web"}}); err != nil {
				t.Fatal(err)
			}
			if _, err := fake.Create(ctx, workspace.CreateOptions{Name: "mono", RootPath: "/Users/me/mono"}); err != nil {
				t.Fatal(err)
			}
			_, err := reg.Invoke(ctx, command.Context{}, "workspace.remove", map[string]string{"workspace": tt.ref})
			var ce *command.ConfirmError
			if !errors.As(err, &ce) {
				t.Fatalf("err = %v, want a ConfirmError", err)
			}
			if !strings.Contains(ce.Message, tt.want) {
				t.Fatalf("confirm %q, want %q", ce.Message, tt.want)
			}
		})
	}
}
