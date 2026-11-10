package command_test

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
	"github.com/alexwaumann/code-foundry/internal/store/workspace/workspacetest"
)

func TestWorkspaceOpenEditor(t *testing.T) {
	const vscode = "com.microsoft.VSCode"
	tests := []struct {
		name     string
		ctx      command.Context
		args     map[string]string
		want     string // the folder opened
		op       *v1.GitOp
		wantCode connect.Code
		wantErr  error
	}{
		{name: "a synthetic workspace: its managed dir", args: map[string]string{"workspace": "shop", "app": vscode}, want: "/workspaces/w-1"},
		{name: "a rooted one by name in any case: its root", args: map[string]string{"workspace": "MONO", "app": vscode}, want: "/Users/me/mono"},
		{name: "the active workspace", ctx: command.Context{ActiveWorkspaceID: "w-2", ActiveView: "projects"}, args: map[string]string{"app": vscode}, want: "/Users/me/mono"},
		{name: "the open fails", args: map[string]string{"workspace": "shop", "app": vscode}, op: &v1.GitOp{State: v1.GitOpState_GIT_OP_STATE_FAILED, Title: "Open w-1 in VS Code", Summary: "open: exit status 1"}, wantCode: connect.CodeUnknown},
		{name: "an app that is not an installed editor", args: map[string]string{"workspace": "shop", "app": "com.apple.Terminal"}, wantErr: command.ErrInvalidArgs},
		{name: "unknown workspace", args: map[string]string{"workspace": "nope", "app": vscode}, wantCode: connect.CodeNotFound},
		{name: "none named", args: map[string]string{"app": vscode}, wantErr: command.ErrInvalidArgs},
		{name: "no app", args: map[string]string{"workspace": "shop"}, wantErr: command.ErrInvalidArgs},
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
			reg := command.NewRegistry()
			editors := &commandtest.GitOps{Apps: []*v1.EditorApp{{Name: "VS Code", BundleId: vscode}}, Op: tt.op}
			if err := command.RegisterWorkspaceOpen(reg, command.WorkspaceOpenDeps{Workspace: api.NewWorkspace(fake, b), Editors: editors}); err != nil {
				t.Fatal(err)
			}
			opened := func() []*v1.OpenEditorRequest {
				var out []*v1.OpenEditorRequest
				for _, r := range editors.Requests() {
					if o, ok := r.(*v1.OpenEditorRequest); ok {
						out = append(out, o)
					}
				}
				return out
			}
			res, err := reg.Invoke(ctx, tt.ctx, "workspace.open.editor", tt.args)
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				if o := opened(); len(o) != 0 {
					t.Fatalf("opened %v, want nothing", o)
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
			if o := opened(); len(o) != 1 || o[0].GetApp() != vscode || o[0].GetWorktreePath() != tt.want {
				t.Fatalf("opened %v, want %s with %s", o, tt.want, vscode)
			}
			if want := "opened " + tt.want + " in VS Code"; res.Message != want {
				t.Errorf("message = %q, want %q", res.Message, want)
			}
		})
	}
}
