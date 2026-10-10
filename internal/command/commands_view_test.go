package command_test

import (
	"context"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func TestViewCommandsEmitShowView(t *testing.T) {
	tests := []struct {
		command, view string
	}{
		{command: "view.dashboard", view: command.ViewDashboard},
		{command: "view.pullrequests", view: command.ViewPullRequests},
		{command: "view.projects", view: command.ViewProjects},
		{command: "view.panel.toggle", view: command.ViewPanelToggle},
		{command: "view.panel.expand", view: command.ViewPanelExpand},
		{command: "view.panel.workspace", view: command.ViewPanelWorkspace},
		{command: "view.panel.linked-prs", view: command.ViewPanelLinkedPRs},
		{command: "view.panel.worktree", view: command.ViewPanelWorktree},
	}
	for _, tt := range tests {
		t.Run(tt.command, func(t *testing.T) {
			reg := command.NewRegistry()
			emit := &commandtest.Emitter{Delivered: 1}
			if err := command.RegisterView(reg, emit); err != nil {
				t.Fatal(err)
			}
			// A workspace thread in a worktree, so view.panel.workspace and view.panel.worktree are available too.
			uctx := command.Context{ActiveSessionID: "s1", ActiveWorkspaceID: "w1", ActiveRepoID: "r1", ActiveWorktreePath: "/wt", ActiveView: "session"}
			res, err := reg.Invoke(context.Background(), uctx, tt.command, nil)
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != "" || res.JSON != (command.EmitResult{Delivered: 1}) {
				t.Errorf("result = %+v, want no message and delivered 1", res)
			}
			got := emit.Intents()
			if len(got) != 1 || got[0].GetShowView().GetName() != tt.view {
				t.Errorf("intents = %v, want one ShowView %q", got, tt.view)
			}
		})
	}
}

func TestViewPanelWorkspaceAvailability(t *testing.T) {
	tests := []struct {
		name string
		ctx  command.Context
		want bool
	}{
		{name: "workspace thread in the GUI", ctx: command.Context{ActiveSessionID: "s1", ActiveWorkspaceID: "w1", ActiveView: "session"}, want: true},
		{name: "workspace thread's terminal", ctx: command.Context{ActiveSessionID: "s1", ActiveTerminalID: "t1", ActiveWorkspaceID: "w1", ActiveView: "terminal"}, want: true},
		{name: "project thread", ctx: command.Context{ActiveSessionID: "s1", ActiveView: "session"}, want: false},
		{name: "workspace composer (no thread)", ctx: command.Context{ActiveRepoID: "r1", ActiveWorkspaceID: "w1", ActiveView: "compose"}, want: false},
		{name: "nothing selected", ctx: command.Context{ActiveView: "dashboard"}, want: false},
		{name: "CLI without context", ctx: command.Context{}, want: false},
		{name: "CLI with --context-session and --context-workspace", ctx: command.Context{ActiveSessionID: "s1", ActiveWorkspaceID: "w1"}, want: true},
	}
	reg := command.NewRegistry()
	if err := command.RegisterView(reg, &commandtest.Emitter{Delivered: 1}); err != nil {
		t.Fatal(err)
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := false
			for _, c := range reg.List(tt.ctx, false) {
				if c.Name == "view.panel.workspace" {
					got = true
				}
			}
			if got != tt.want {
				t.Errorf("available = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestViewPanelLinkedPRsAvailability(t *testing.T) {
	tests := []struct {
		name string
		ctx  command.Context
		want bool
	}{
		{name: "project thread in the GUI", ctx: command.Context{ActiveSessionID: "s1", ActiveView: "session"}, want: true},
		{name: "workspace thread", ctx: command.Context{ActiveSessionID: "s1", ActiveWorkspaceID: "w1", ActiveView: "session"}, want: true},
		{name: "thread's terminal", ctx: command.Context{ActiveSessionID: "s1", ActiveTerminalID: "t1", ActiveView: "terminal"}, want: true},
		{name: "plain terminal", ctx: command.Context{ActiveTerminalID: "t1", ActiveView: "terminal"}, want: false},
		{name: "worktree", ctx: command.Context{ActiveRepoID: "r1", ActiveWorktreePath: "/wt", ActiveView: "worktree"}, want: false},
		{name: "workspace composer (no thread)", ctx: command.Context{ActiveRepoID: "r1", ActiveWorkspaceID: "w1", ActiveView: "compose"}, want: false},
		{name: "nothing selected", ctx: command.Context{ActiveView: "dashboard"}, want: false},
		{name: "CLI without context", ctx: command.Context{}, want: false},
		{name: "CLI with --context-session", ctx: command.Context{ActiveSessionID: "s1"}, want: true},
	}
	reg := command.NewRegistry()
	if err := command.RegisterView(reg, &commandtest.Emitter{Delivered: 1}); err != nil {
		t.Fatal(err)
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := false
			for _, c := range reg.List(tt.ctx, false) {
				if c.Name == "view.panel.linked-prs" {
					got = true
				}
			}
			if got != tt.want {
				t.Errorf("available = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestViewPanelWorktreeAvailability(t *testing.T) {
	tests := []struct {
		name string
		ctx  command.Context
		want bool
	}{
		{name: "thread in a worktree", ctx: command.Context{ActiveSessionID: "s1", ActiveRepoID: "r1", ActiveWorktreePath: "/wt", ActiveView: "session"}, want: true},
		{name: "thread's terminal", ctx: command.Context{ActiveSessionID: "s1", ActiveTerminalID: "t1", ActiveRepoID: "r1", ActiveWorktreePath: "/wt", ActiveView: "terminal"}, want: true},
		{name: "plain terminal in a worktree", ctx: command.Context{ActiveTerminalID: "t1", ActiveRepoID: "r1", ActiveWorktreePath: "/wt", ActiveView: "terminal"}, want: true},
		{name: "thread outside any worktree", ctx: command.Context{ActiveSessionID: "s1", ActiveView: "session"}, want: false},
		{name: "thread with a repo but no worktree", ctx: command.Context{ActiveSessionID: "s1", ActiveRepoID: "r1", ActiveView: "session"}, want: false},
		{name: "worktree page", ctx: command.Context{ActiveRepoID: "r1", ActiveWorktreePath: "/wt", ActiveView: "worktree"}, want: false},
		{name: "repo page", ctx: command.Context{ActiveRepoID: "r1", ActiveWorktreePath: "/src", ActiveView: "repo"}, want: false},
		{name: "composer", ctx: command.Context{ActiveRepoID: "r1", ActiveView: "compose"}, want: false},
		{name: "nothing selected", ctx: command.Context{ActiveView: "dashboard"}, want: false},
		{name: "CLI without context", ctx: command.Context{}, want: false},
		{name: "CLI with --context-session, --context-repo and --context-worktree", ctx: command.Context{ActiveSessionID: "s1", ActiveRepoID: "r1", ActiveWorktreePath: "/wt"}, want: true},
	}
	reg := command.NewRegistry()
	if err := command.RegisterView(reg, &commandtest.Emitter{Delivered: 1}); err != nil {
		t.Fatal(err)
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := false
			for _, c := range reg.List(tt.ctx, false) {
				if c.Name == "view.panel.worktree" {
					got = true
				}
			}
			if got != tt.want {
				t.Errorf("available = %v, want %v", got, tt.want)
			}
		})
	}
}
