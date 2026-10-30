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
		{command: "view.usage", view: command.ViewUsage},
		{command: "view.pullrequests", view: command.ViewPullRequests},
		{command: "view.projects", view: command.ViewProjects},
		{command: "view.settings", view: command.ViewSettings},
		{command: "view.help", view: command.ViewHelp},
		{command: "view.panel.toggle", view: command.ViewPanelToggle},
		{command: "view.bottom.toggle", view: command.ViewBottomToggle},
		{command: "view.panel.expand", view: command.ViewPanelExpand},
		{command: "view.panel.new-tab", view: command.ViewPanelNewTab},
		{command: "view.panel.split", view: command.ViewPanelSplit},
		{command: "view.back", view: command.ViewBack},
		{command: "view.forward", view: command.ViewForward},
		{command: "thread.previous", view: command.ViewThreadPrevious},
		{command: "thread.next", view: command.ViewThreadNext},
		{command: "composer.history", view: command.ViewComposerHistory},
		{command: "view.thread-info", view: command.ViewThreadInfo},
	}
	for _, tt := range tests {
		t.Run(tt.command, func(t *testing.T) {
			reg := command.NewRegistry()
			emit := &commandtest.Emitter{Delivered: 1, OpenWindows: 1}
			if err := command.RegisterView(reg, command.ViewDeps{Emitter: emit, Thread: &commandtest.Thread{}}); err != nil {
				t.Fatal(err)
			}
			// A thread in a worktree.
			uctx := command.Context{ActiveThreadID: "s1", ActiveWorkspaceID: "w1", ActiveProjectID: "r1", ActiveWorktreePath: "/wt", ActiveView: "thread"}
			res, err := reg.Invoke(context.Background(), uctx, tt.command, nil)
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != "" || res.JSON != (command.EmitResult{Windows: 1, Receivers: 1}) {
				t.Errorf("result = %+v, want no message and delivered 1", res)
			}
			got := emit.Intents()
			if len(got) != 1 || got[0].GetShowView().GetName() != tt.view {
				t.Errorf("intents = %v, want one ShowView %q", got, tt.view)
			}
		})
	}
}

// view.panel.diff is listed for a thread in a project worktree, or the CLI in a thread
// (Run reads the thread's worktree).
func TestViewPanelDiffAvailability(t *testing.T) {
	tests := []struct {
		name string
		ctx  command.Context
		want bool
	}{
		{name: "thread in a worktree", ctx: command.Context{ActiveThreadID: "s1", ActiveProjectID: "r1", ActiveWorktreePath: "/wt", ActiveView: "thread"}, want: true},
		{name: "thread with its terminal", ctx: command.Context{ActiveThreadID: "s1", ActiveTerminalID: "t1", ActiveProjectID: "r1", ActiveWorktreePath: "/wt", ActiveView: "thread"}, want: true},
		{name: "Projects page bottom shell in a worktree (no thread)", ctx: command.Context{ActiveTerminalID: "t1", ActiveProjectID: "r1", ActiveWorktreePath: "/wt", ActiveView: "projects"}, want: false},
		{name: "thread outside any worktree", ctx: command.Context{ActiveThreadID: "s1", ActiveView: "thread"}, want: false},
		{name: "thread in its workspace's folder", ctx: command.Context{ActiveThreadID: "s1", ActiveWorkspaceID: "w-1", ActiveWorktreePath: "/Users/me/mono", ActiveView: "thread"}, want: false},
		{name: "thread with a workspace but no cwd", ctx: command.Context{ActiveThreadID: "s1", ActiveWorkspaceID: "w-1", ActiveView: "thread"}, want: false},
		{name: "Projects page with a workspace card's context (no thread)", ctx: command.Context{ActiveWorkspaceID: "w-1", ActiveWorktreePath: "/Users/me/mono", ActiveView: "projects"}, want: false},
		{name: "thread with a project but no worktree", ctx: command.Context{ActiveThreadID: "s1", ActiveProjectID: "r1", ActiveView: "thread"}, want: false},
		{name: "worktree page", ctx: command.Context{ActiveProjectID: "r1", ActiveWorktreePath: "/wt", ActiveView: "worktree"}, want: false},
		{name: "projects page", ctx: command.Context{ActiveProjectID: "r1", ActiveWorktreePath: "/src", ActiveView: "projects"}, want: false},
		{name: "composer", ctx: command.Context{ActiveProjectID: "r1", ActiveView: "compose"}, want: false},
		{name: "nothing selected", ctx: command.Context{ActiveView: "dashboard"}, want: false},
		{name: "CLI without context", ctx: command.Context{}, want: false},
		{name: "CLI with --context-thread, --context-project and --context-worktree", ctx: command.Context{ActiveThreadID: "s1", ActiveProjectID: "r1", ActiveWorktreePath: "/wt"}, want: true},
		// Run reads the thread's worktree (commands_view_thread.go).
		{name: "CLI in a thread ($CODE_FOUNDRY_THREAD)", ctx: command.Context{ActiveThreadID: "s1"}, want: true},
	}
	reg := command.NewRegistry()
	if err := command.RegisterView(reg, command.ViewDeps{Emitter: &commandtest.Emitter{Delivered: 1, OpenWindows: 1}, Thread: &commandtest.Thread{}}); err != nil {
		t.Fatal(err)
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := false
			for _, c := range reg.List(tt.ctx, false) {
				if c.Name == "view.panel.diff" {
					got = true
				}
			}
			if got != tt.want {
				t.Errorf("available = %v, want %v", got, tt.want)
			}
		})
	}
}
