package daemon

import (
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

func TestCleanupHold(t *testing.T) {
	const wt = "/wt/cf-a"
	ws := &workspace.Snapshot{Workspaces: []workspace.Workspace{{ID: "w-1", Name: "pay", Members: []workspace.Member{{RepoID: "r1", WorktreePath: "/wt/cf-pay"}}}}}
	shell := func(state terminal.State, cwd, owner string) terminal.Terminal {
		l := map[string]string{termlabel.Kind: termlabel.KindShell}
		if owner != "" {
			l[termlabel.Worktree] = owner
		}
		return terminal.Terminal{ID: "t", State: state, Cwd: cwd, Labels: l}
	}
	tests := []struct {
		name      string
		path      string
		threads   []workspace.Thread
		terminals []terminal.Terminal
		ws        *workspace.Snapshot
		want      string
	}{
		{name: "nothing", path: wt, ws: ws, want: ""},
		{name: "nil workspaces", path: wt, want: ""},
		{name: "live thread in it", path: wt, threads: []workspace.Thread{{ID: "s1", Name: "fix-badge", Cwd: wt}}, want: "live thread fix-badge runs in it"},
		{name: "unnamed thread in a subdirectory", path: wt, threads: []workspace.Thread{{ID: "s1", Cwd: wt + "/sub"}}, want: "a live thread runs in it"},
		{name: "thread in a sibling with a common prefix", path: wt, threads: []workspace.Thread{{ID: "s1", Cwd: wt + "-other"}}, want: ""},
		{name: "running shell owned by it", path: wt, terminals: []terminal.Terminal{shell(terminal.StateRunning, "/elsewhere", wt)}, want: "a terminal is open in it"},
		{name: "running terminal inside it", path: wt, terminals: []terminal.Terminal{shell(terminal.StateRunning, wt+"/sub", "")}, want: "a terminal is open in it"},
		{name: "exited shell", path: wt, terminals: []terminal.Terminal{shell(terminal.StateExited, wt, wt)}, want: ""},
		{name: "shell elsewhere", path: wt, terminals: []terminal.Terminal{shell(terminal.StateRunning, "/wt/cf-b", "/wt/cf-b")}, want: ""},
		{name: "workspace member", path: "/wt/cf-pay", ws: ws, want: "member of workspace pay"},
		{name: "thread wins over workspace", path: "/wt/cf-pay", ws: ws, threads: []workspace.Thread{{Name: "x", Cwd: "/wt/cf-pay"}}, want: "live thread x runs in it"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := cleanupHold(tt.path, tt.threads, tt.terminals, tt.ws); got != tt.want {
				t.Errorf("cleanupHold = %q, want %q", got, tt.want)
			}
		})
	}
}
