package daemon

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// A plugin's terminal is labelled for it; only the plugin's own are listed, a shell has
// no plugin owner, and closing removes it (twice is fine).
func TestPluginTerminals(t *testing.T) {
	ctx := context.Background()
	f := terminaltest.New(bus.New())
	p := pluginTerminals{terminals: f}
	shell, err := f.Create(ctx, terminal.Spec{Argv: []string{"zsh"}, Labels: termlabel.Shell("", "r1", "/w")})
	if err != nil {
		t.Fatal(err)
	}
	pt, err := p.Create(ctx, "hello", plugin.TerminalSpec{Argv: []string{"sh", "-c", "date"}, Cwd: "/tmp", Title: "Clock"})
	if err != nil {
		t.Fatal(err)
	}
	if pt.Title != "Clock" || pt.State != "running" || !slices.Equal(pt.Argv, []string{"sh", "-c", "date"}) {
		t.Errorf("created %+v", pt)
	}
	got, _ := f.Get(ctx, pt.TerminalID)
	if !termlabel.IsPlugin(got.Labels) || got.Labels[termlabel.Plugin] != "hello" || got.Labels[termlabel.Title] != "Clock" {
		t.Errorf("labels %v", got.Labels)
	}
	if o, ok := p.Owner(pt.TerminalID); !ok || o != "hello" {
		t.Errorf("Owner = %q, %v", o, ok)
	}
	if o, ok := p.Owner(shell.ID); !ok || o != "" {
		t.Errorf("shell Owner = %q, %v", o, ok)
	}
	if _, ok := p.Owner("t-nope"); ok {
		t.Error("an unknown terminal has an owner")
	}
	if list := p.Owned("hello"); len(list) != 1 || list[0].TerminalID != pt.TerminalID {
		t.Errorf("Owned = %+v", list)
	}
	if err := p.Close(ctx, pt.TerminalID); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(ctx, pt.TerminalID); err != nil { // gone already counts as closed
		t.Errorf("second Close = %v", err)
	}
	if list := p.Owned("hello"); len(list) != 0 {
		t.Errorf("after Close: %+v", list)
	}
}

func TestPluginThreadOf(t *testing.T) {
	at := time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)
	got := pluginThreadOf(thread.Thread{ID: "s-1", Name: "Assistant", WorktreePath: "/h/d", Model: "m", Effort: "low",
		State: thread.StateDisconnected, Status: thread.StatusNeedsAttention, ArchivedAt: at, CreatedAt: at})
	if got.ThreadID != "s-1" || got.Title != "Assistant" || got.Cwd != "/h/d" || got.State != "disconnected" ||
		got.Status != "attention" || !got.Archived || !got.CreatedAt.Equal(at) {
		t.Errorf("pluginThreadOf = %+v", got)
	}
	if got := pluginThreadOf(thread.Thread{}); got.State != "unknown" || got.Status != "unknown" {
		t.Errorf("zero = %+v", got)
	}
}

// A plugin thread's options: the user's defaults fill an empty model and effort, the
// permission mode maps to the thread store's (none is Claude's default), an unknown one
// is an invalid argument, and a project picks the worktree over the cwd.
func TestPluginCreateOptions(t *testing.T) {
	defaults := settings.Threads{DefaultModel: "claude-sonnet-5[1m]", DefaultEffort: "medium"}
	for _, tt := range []struct {
		name    string
		spec    plugin.ThreadSpec
		want    thread.CreateOptions
		wantErr bool
	}{
		{name: "defaults", spec: plugin.ThreadSpec{Title: "A", Cwd: "/h/d"},
			want: thread.CreateOptions{Owner: "plugin:p", Name: "A", Model: "claude-sonnet-5[1m]", Effort: "medium", NoProject: true, Cwd: "/h/d"}},
		{name: "own model and effort", spec: plugin.ThreadSpec{Title: "A", Model: "m", Effort: "low"},
			want: thread.CreateOptions{Owner: "plugin:p", Name: "A", Model: "m", Effort: "low", NoProject: true}},
		{name: "supervised", spec: plugin.ThreadSpec{Title: "A", PermissionMode: pluginsdk.PermissionModeSupervised},
			want: thread.CreateOptions{Owner: "plugin:p", Name: "A", Model: "claude-sonnet-5[1m]", Effort: "medium", NoProject: true, PermissionMode: thread.PermissionSupervised}},
		{name: "accept edits", spec: plugin.ThreadSpec{Title: "A", PermissionMode: pluginsdk.PermissionModeAcceptEdits},
			want: thread.CreateOptions{Owner: "plugin:p", Name: "A", Model: "claude-sonnet-5[1m]", Effort: "medium", NoProject: true, PermissionMode: thread.PermissionAcceptEdits}},
		{name: "auto in a project", spec: plugin.ThreadSpec{Title: "A", ProjectID: "r1", Cwd: "/w", PermissionMode: pluginsdk.PermissionModeAuto, Prompt: "hi"},
			want: thread.CreateOptions{Owner: "plugin:p", Name: "A", Model: "claude-sonnet-5[1m]", Effort: "medium", ProjectID: "r1", WorktreePath: "/w", InitialPrompt: "hi", PermissionMode: thread.PermissionAuto}},
		{name: "unknown mode", spec: plugin.ThreadSpec{Title: "A", PermissionMode: "bypassPermissions"}, wantErr: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := pluginCreateOptions("plugin:p", tt.spec, defaults)
			if tt.wantErr {
				if !errors.Is(err, plugin.ErrInvalidArgument) {
					t.Fatalf("err = %v, want ErrInvalidArgument", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("options =\n %+v\nwant\n %+v", got, tt.want)
			}
		})
	}
}
