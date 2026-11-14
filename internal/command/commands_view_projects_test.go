package command_test

import (
	"context"
	"errors"
	"maps"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
)

// view.projects shows the Projects page's tab; --project or --workspace says which page in the
// tab's params (a workspace by its id, from its id or name). No intent goes out.
func TestViewProjectsPage(t *testing.T) {
	ws := listWorkspaces{ws: []*v1.Workspace{{Id: "w-1", Name: "Platform"}}}
	tests := []struct {
		name    string
		args    map[string]string
		want    map[string]string
		wantErr string // "not found", or "arg" for an ArgError
	}{
		{name: "no args: the page the window showed last", args: nil, want: nil},
		{name: "a project", args: map[string]string{"project": "r1"}, want: map[string]string{"project": "r1"}},
		{name: "a workspace by id", args: map[string]string{"workspace": "w-1"}, want: map[string]string{"workspace": "w-1"}},
		{name: "a workspace by name, any case", args: map[string]string{"workspace": "platform"}, want: map[string]string{"workspace": "w-1"}},
		{name: "an unknown workspace", args: map[string]string{"workspace": "gone"}, wantErr: "not found"},
		{name: "both", args: map[string]string{"project": "r1", "workspace": "w-1"}, wantErr: "arg"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			emit := &commandtest.Emitter{Delivered: 1, OpenWindows: 1}
			store := layouttest.New(nil)
			if err := command.RegisterView(reg, command.ViewDeps{Emitter: emit, Workspaces: ws, Layout: store}); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s1", ActiveView: "thread"}, "view.projects", tt.args)
			if tt.wantErr != "" {
				var ce *connect.Error
				var ae *command.ArgError
				if ok := (tt.wantErr == "arg" && errors.As(err, &ae)) || (tt.wantErr == "not found" && errors.As(err, &ce) && ce.Code() == connect.CodeNotFound); !ok {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				if n := len(emit.Intents()); n != 0 {
					t.Errorf("emitted %d intents on an error", n)
				}
				if ops := store.Ops(); len(ops) != 0 {
					t.Errorf("ops = %v on an error, want none", ops)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := emit.Intents(); len(got) != 0 {
				t.Fatalf("intents = %v, want none", got)
			}
			_, _, tb := store.Snapshot().State.FindTab(res.JSON.(command.PageTabResult).Tab)
			if tb == nil || tb.Kind != "projects" || !maps.Equal(tb.Params, tt.want) && (len(tb.Params) != 0 || len(tt.want) != 0) {
				t.Errorf("tab = %+v, want projects with %v", tb, tt.want)
			}
		})
	}
}
