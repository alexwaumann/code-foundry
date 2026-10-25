package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
	"github.com/alexwaumann/code-foundry/internal/store/workspace/workspacetest"
)

func newWorkspaceRegistry(t *testing.T) (*command.Registry, *workspacetest.Fake) {
	t.Helper()
	b := bus.New()
	fake := workspacetest.New(b)
	reg := command.NewRegistry()
	if err := command.RegisterWorkspace(reg, api.NewWorkspace(fake, b)); err != nil {
		t.Fatal(err)
	}
	return reg, fake
}

func TestWorkspaceCommands(t *testing.T) {
	tests := []struct {
		name     string
		cmd      string
		ctx      command.Context
		args     map[string]string
		wantErr  error
		wantMsg  []string // substrings of the message (or error)
		wantCall string   // last fake call
		wantJSON string
	}{
		{name: "new", cmd: "workspace.new", args: map[string]string{"name": "shop", "projects": "web, api ,"},
			wantMsg:  []string{"created workspace shop (w-2): 2 projects (api, web), starts in web, folder /workspaces/w-2"},
			wantCall: "Create shop", wantJSON: `"defaultPrimary":"web"`},
		{name: "new with a root", cmd: "workspace.new", args: map[string]string{"name": "mono", "root": "/Users/me/mono"},
			wantMsg: []string{"0 projects, starts in workspace, root /Users/me/mono"}, wantCall: "Create mono"},
		{name: "new without projects or root", cmd: "workspace.new", args: map[string]string{"name": "x", "projects": " , "}, wantErr: command.ErrInvalidArgs, wantMsg: []string{"at least one"}},
		{name: "new without a name", cmd: "workspace.new", args: map[string]string{"projects": "web"}, wantErr: command.ErrInvalidArgs},
		{name: "a taken name, any case", cmd: "workspace.new", args: map[string]string{"name": "BASE", "projects": "web"}, wantMsg: []string{"exists"}},
		{name: "list", cmd: "workspace.list", wantMsg: []string{"base (w-1): 2 projects (api, web), starts in api"}},
		{name: "add a project", cmd: "workspace.add-project", args: map[string]string{"project": "lib", "workspace": "base"},
			wantMsg: []string{"added lib to workspace base (w-1): 3 projects (api, lib, web)"}, wantCall: "AddProject base lib"},
		{name: "add a project to the active workspace", cmd: "workspace.add-project", ctx: command.Context{ActiveWorkspaceID: "w-1"},
			args: map[string]string{"project": "lib"}, wantCall: "AddProject w-1 lib"},
		{name: "add a project needs a workspace", cmd: "workspace.add-project", args: map[string]string{"project": "lib"}, wantErr: command.ErrInvalidArgs},
		{name: "remove a project moves the default", cmd: "workspace.remove-project", args: map[string]string{"project": "api", "workspace": "base"},
			wantMsg: []string{"1 project (web), starts in workspace"}, wantCall: "RemoveProject base api"},
		{name: "rename", cmd: "workspace.rename", args: map[string]string{"name": "Store", "workspace": "base"},
			wantMsg: []string{"renamed workspace Store (w-1)"}, wantCall: "Rename base Store"},
		{name: "set the default primary", cmd: "workspace.set-primary", args: map[string]string{"primary": "workspace", "workspace": "base"},
			wantMsg: []string{"starts in workspace"}, wantCall: "SetDefaultPrimary base workspace"},
		{name: "remove", cmd: "workspace.remove", args: map[string]string{"workspace": "base"},
			wantMsg: []string{"removed workspace base"}, wantCall: "Remove base"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newWorkspaceRegistry(t)
			if _, err := fake.Create(context.Background(), workspace.CreateOptions{Name: "base", Members: []string{"web", "api"}, DefaultPrimary: "api"}); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), tt.ctx, tt.cmd, tt.args, command.Confirmed(true))
			text := res.Message
			if err != nil {
				text = err.Error()
			}
			switch {
			case tt.wantErr != nil && !errors.Is(err, tt.wantErr):
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			case tt.wantErr == nil && err != nil && len(tt.wantMsg) == 0:
				t.Fatal(err)
			}
			for _, want := range tt.wantMsg {
				if !strings.Contains(text, want) {
					t.Errorf("message %q, want %q", text, want)
				}
			}
			if calls := fake.Calls(); tt.wantCall != "" && calls[len(calls)-1] != tt.wantCall {
				t.Errorf("calls %q, want the last %q", calls, tt.wantCall)
			}
			if tt.wantJSON != "" {
				j, jerr := res.EncodeJSON()
				if jerr != nil || !strings.Contains(string(j), tt.wantJSON) {
					t.Errorf("json = %s (%v), want %s", j, jerr, tt.wantJSON)
				}
			}
		})
	}
}
