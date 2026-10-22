package command_test

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/all"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// panelVerbs are every verb that acts on a side panel, with the ShowView name each emits.
var panelVerbs = map[string]string{
	"view.panel.toggle":     command.ViewPanelToggle,
	"view.panel.expand":     command.ViewPanelExpand,
	"view.panel.new-tab":    command.ViewPanelNewTab,
	"view.panel.split":      command.ViewPanelSplit,
	"view.panel.workspace":  command.ViewPanelWorkspace,
	"view.panel.linked-prs": command.ViewPanelLinkedPRs,
	"view.panel.usage":      command.ViewPanelUsage,
	"view.panel.threads":    command.ViewPanelThreads,
	"view.panel.worktree":   command.ViewPanelWorktree,
	"view.panel.mcp":        command.ViewPanelMcp,
	"view.panel.agents":     command.ViewPanelAgents,
}

// panelRegistry registers every command, with threads read from th.
func panelRegistry(t *testing.T, th *commandtest.Thread) (*command.Registry, *commandtest.Emitter) {
	t.Helper()
	reg := command.NewRegistry()
	emit := &commandtest.Emitter{Delivered: 1}
	if err := all.Register(reg, all.Deps{Emitter: emit, Thread: th}); err != nil {
		t.Fatal(err)
	}
	return reg, emit
}

func showView(name, thread string) *v1.UiIntent {
	return &v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: name, ThreadId: thread}}}
}

func focusThread(id string) *v1.UiIntent {
	return &v1.UiIntent{Intent: &v1.UiIntent_FocusThread_{FocusThread: &v1.UiIntent_FocusThread{ThreadId: id}}}
}

func sameIntents(t *testing.T, got, want []*v1.UiIntent) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("intents = %v, want %v", got, want)
	}
	for i := range got {
		if got[i].String() != want[i].String() {
			t.Errorf("intent %d = %v, want %v", i, got[i], want[i])
		}
	}
}

// Every panel verb, from the GUI and the CLI: scoped to a thread only from the CLI with
// one (or with an explicit --thread), unscoped otherwise, and --focus selects first.
func TestPanelVerbsThreadScope(t *testing.T) {
	gui := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1", ActiveWorkspaceID: "w1", ActiveProjectID: "r1", ActiveWorktreePath: "/wt", ActiveView: "thread"}
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	tests := []struct {
		name        string
		ctx         command.Context
		args        map[string]string
		wantThread  string
		wantFocus   bool
		wantMessage bool
	}{
		{name: "the app's palette acts on each window's selection", ctx: gui},
		{name: "the app's palette with --focus changes nothing", ctx: gui, args: map[string]string{"focus": "true"}},
		{name: "the app with an explicit --thread", ctx: gui, args: map[string]string{"thread": "s-bbbbbbbbbbb2"}, wantThread: "s-bbbbbbbbbbb2"},
		{name: "the CLI in a thread acts on that thread", ctx: inThread, wantThread: "s-aaaaaaaaaaa1", wantMessage: true},
		{name: "the CLI in a thread with --thread", ctx: inThread, args: map[string]string{"thread": "s-bbbbbbbbbbb2"}, wantThread: "s-bbbbbbbbbbb2", wantMessage: true},
		{name: "the CLI in a thread with --focus", ctx: inThread, args: map[string]string{"focus": "true"}, wantThread: "s-aaaaaaaaaaa1", wantFocus: true, wantMessage: true},
		{name: "the CLI outside a thread with --thread", ctx: command.Context{}, args: map[string]string{"thread": "s-bbbbbbbbbbb2"}, wantThread: "s-bbbbbbbbbbb2", wantMessage: true},
	}
	th := &commandtest.Thread{Current: &v1.Thread{ProjectId: "r1", WorktreePath: "/wt", WorkspaceId: "w1"}}
	for verb, view := range panelVerbs {
		for _, tt := range tests {
			t.Run(verb+"/"+tt.name, func(t *testing.T) {
				reg, emit := panelRegistry(t, th)
				res, err := reg.Invoke(context.Background(), tt.ctx, verb, tt.args)
				if err != nil {
					t.Fatal(err)
				}
				var want []*v1.UiIntent
				if tt.wantFocus {
					want = append(want, focusThread(tt.wantThread))
				}
				sameIntents(t, emit.Intents(), append(want, showView(view, tt.wantThread)))
				var wantJSON any = command.EmitResult{Delivered: 1}
				if tt.wantThread != "" {
					wantJSON = command.PanelResult{Delivered: 1, Thread: tt.wantThread, Focused: tt.wantFocus}
				}
				if res.JSON != wantJSON {
					t.Errorf("JSON = %+v, want %+v", res.JSON, wantJSON)
				}
				wantMsg := ""
				if tt.wantMessage {
					wantMsg = "delivered=1 thread=" + tt.wantThread
				}
				if res.Message != wantMsg {
					t.Errorf("message = %q, want %q", res.Message, wantMsg)
				}
			})
		}
	}
}

// The panel actions that need no thread run from the CLI outside one as before: every
// window's selection. --focus there has no thread to select.
func TestPanelVerbsOutsideAThread(t *testing.T) {
	for _, verb := range []string{"view.panel.toggle", "view.panel.expand", "view.panel.new-tab", "view.panel.split"} {
		t.Run(verb, func(t *testing.T) {
			reg, emit := panelRegistry(t, &commandtest.Thread{})
			res, err := reg.Invoke(context.Background(), command.Context{}, verb, nil)
			if err != nil {
				t.Fatal(err)
			}
			sameIntents(t, emit.Intents(), []*v1.UiIntent{showView(panelVerbs[verb], "")})
			if res.Message != "" || res.JSON != (command.EmitResult{Delivered: 1}) {
				t.Errorf("result = %+v, want no message and delivered 1", res)
			}
			_, err = reg.Invoke(context.Background(), command.Context{}, verb, map[string]string{"focus": "true"})
			var argErr *command.ArgError
			if !errors.As(err, &argErr) || argErr.Arg != "focus" {
				t.Errorf("--focus outside a thread: err = %v, want an ArgError for focus", err)
			}
		})
	}
}

// A scoped call reads its thread: an unknown one fails, and the workspace and worktree
// surfaces refuse a thread placed where they cannot show. Nothing is emitted then.
func TestPanelVerbsCheckTheThread(t *testing.T) {
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	tests := []struct {
		name   string
		verb   string
		thread *commandtest.Thread
		code   connect.Code
	}{
		{name: "unknown thread", verb: "view.panel.usage", thread: &commandtest.Thread{Err: connect.NewError(connect.CodeNotFound, errors.New("no thread"))}, code: connect.CodeNotFound},
		{name: "unknown thread with --focus", verb: "view.panel.toggle", thread: &commandtest.Thread{Err: connect.NewError(connect.CodeNotFound, errors.New("no thread"))}, code: connect.CodeNotFound},
		{name: "workspace surface for a project thread", verb: "view.panel.workspace", thread: &commandtest.Thread{Current: &v1.Thread{ProjectId: "r1", WorktreePath: "/wt"}}, code: connect.CodeFailedPrecondition},
		{name: "worktree surface for a thread in no project", verb: "view.panel.worktree", thread: &commandtest.Thread{Current: &v1.Thread{WorktreePath: "/home"}}, code: connect.CodeFailedPrecondition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, emit := panelRegistry(t, tt.thread)
			_, err := reg.Invoke(context.Background(), inThread, tt.verb, map[string]string{"focus": "true"})
			if connect.CodeOf(err) != tt.code {
				t.Errorf("err = %v, want code %v", err, tt.code)
			}
			if got := emit.Intents(); len(got) != 0 {
				t.Errorf("intents = %v, want none", got)
			}
		})
	}
}
