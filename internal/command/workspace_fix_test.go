package command_test

import (
	"context"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Fuzz round fixes (docs/notes/workspaces-v2-fix-1-workspace.md).

// thread.checkouts: a thread without projects keeps the workspace on its own line; a
// rooted workspace's row is its root, "(missing)" when gone; a stray real file in the
// managed dir gets a warning line.
func TestFormatCheckoutsWorkspace(t *testing.T) {
	tests := []struct {
		name string
		resp *v1.ThreadCheckoutsResponse
		want string
	}{
		{name: "no projects", resp: &v1.ThreadCheckoutsResponse{
			Thread:      &v1.Thread{Id: "s1", WorkspaceId: "w-1", WorktreePath: "/cfg/workspaces/w-1"},
			WorkspaceId: "w-1", WorkspaceName: "zero", WorkspaceDir: "/cfg/workspaces/w-1"},
			want: "thread s1: each project in its own checkout; runs in its workspace's folder /cfg/workspaces/w-1\n" +
				"no projects (the thread runs in /cfg/workspaces/w-1)\n" +
				"WORKSPACE zero  /cfg/workspaces/w-1"},
		{name: "a missing root and a stray", resp: &v1.ThreadCheckoutsResponse{
			Thread:      &v1.Thread{Id: "s1", WorkspaceId: "w-1", WorktreePath: "/src/web", ProjectId: "web"},
			WorkspaceId: "w-1", WorkspaceName: "mono", WorkspaceDir: "/Users/me/mono", WorkspaceDirMissing: true,
			WorkspaceStrays: []string{"/cfg/workspaces/w-1/CLAUDE.md"}},
			want: "thread s1: each project in its own checkout\n" +
				"no projects (the thread runs in /src/web)\n" +
				"WORKSPACE mono  /Users/me/mono (missing)\n" +
				"/cfg/workspaces/w-1/CLAUDE.md is a real file; the workspace's root has the one Claude loads"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := command.FormatCheckouts(tt.resp); got != tt.want {
				t.Errorf("got:\n%s\nwant:\n%s", got, tt.want)
			}
		})
	}
}

// Workspace messages name projects when the registry knows their names; set-root
// reaches the store; a missing root is marked.
func TestWorkspaceCommandNames(t *testing.T) {
	reg, fake := newWorkspaceRegistry(t)
	reg.SetProjectNames(func(context.Context) (map[string]string, error) {
		return map[string]string{"r-web": "web", "r-api": "api"}, nil
	})
	ctx := context.Background()
	if _, err := fake.Create(ctx, workspace.CreateOptions{Name: "shop", Members: []string{"r-web", "r-api"}, DefaultPrimary: "r-api"}); err != nil {
		t.Fatal(err)
	}
	fake.Put(workspace.Workspace{ID: "w-mono", Name: "mono", RootPath: "/Users/me/mono", RootMissing: true, DefaultPrimary: workspace.PrimaryWorkspace})
	res, err := reg.Invoke(ctx, command.Context{}, "workspace.list", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"shop (w-1): 2 projects (api, web), starts in api", "root /Users/me/mono (missing: workspace set-root)"} {
		if !strings.Contains(res.Message, want) {
			t.Errorf("list %q, want %q", res.Message, want)
		}
	}
	res, err = reg.Invoke(ctx, command.Context{}, "workspace.set-root", map[string]string{"root": "/Users/me/mono2", "workspace": "mono"})
	if err != nil || !strings.Contains(res.Message, "root /Users/me/mono2") {
		t.Fatalf("set-root = %q, %v", res.Message, err)
	}
	if calls := fake.Calls(); calls[len(calls)-1] != "SetRoot mono /Users/me/mono2" {
		t.Errorf("calls %v", calls)
	}
	if _, err := reg.Invoke(ctx, command.Context{}, "workspace.set-root", map[string]string{"root": "/Users/me/x", "workspace": "shop"}); err == nil || !strings.Contains(err.Error(), "has no root") {
		t.Errorf("set-root of a synthetic workspace = %v", err)
	}
}
