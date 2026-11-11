package command_test

import (
	"context"
	"fmt"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/pluginscaffold"
)

func TestPluginNew(t *testing.T) {
	cmds := pluginscaffold.GoCommands("code-foundry-plugin-hello", "main")
	tests := []struct {
		name     string
		args     map[string]string
		res      pluginscaffold.Result
		err      error
		want     string
		wantCode int
		wantErr  connect.Code
	}{
		{
			name: "owner",
			args: map[string]string{"name": "hello", "dir": "/Users/a/src", "owner": "octo"},
			res:  pluginscaffold.Result{Dir: "/Users/a/src/code-foundry-plugin-hello", Module: "github.com/octo/code-foundry-plugin-hello", Files: make([]string, 10)},
			want: "created /Users/a/src/code-foundry-plugin-hello (module github.com/octo/code-foundry-plugin-hello, 10 files)\n" +
				"next: cd /Users/a/src/code-foundry-plugin-hello && make build && code-foundry plugin dev \"$PWD\" --follow=false",
		},
		{
			name: "bare module, quoted folder",
			args: map[string]string{"name": "hello", "dir": "/Users/a/my code"},
			res:  pluginscaffold.Result{Dir: "/Users/a/my code/code-foundry-plugin-hello", Module: "code-foundry-plugin-hello", Files: make([]string, 10)},
			want: "created /Users/a/my code/code-foundry-plugin-hello (module code-foundry-plugin-hello, 10 files)\n" +
				"next: cd '/Users/a/my code/code-foundry-plugin-hello' && make build && code-foundry plugin dev \"$PWD\" --follow=false\n" +
				"before publishing: go mod edit -module github.com/<owner>/code-foundry-plugin-hello",
		},
		{
			name: "go fails",
			args: map[string]string{"name": "hello", "dir": "/Users/a/src"},
			res: pluginscaffold.Result{Dir: "/Users/a/src/code-foundry-plugin-hello", Module: "code-foundry-plugin-hello", Files: make([]string, 10),
				GoError: "exit status 127: zsh: command not found: go", Finish: cmds},
			want: "created /Users/a/src/code-foundry-plugin-hello (module code-foundry-plugin-hello, 10 files)\n" +
				"the go step failed: exit status 127: zsh: command not found: go\n" +
				"finish it by hand:\n" +
				"  cd /Users/a/src/code-foundry-plugin-hello\n" +
				"  go mod init code-foundry-plugin-hello\n" +
				"  go get github.com/alexwaumann/code-foundry/pluginsdk@main\n" +
				"  go mod tidy\n" +
				"then: make build && code-foundry plugin dev \"$PWD\" --follow=false\n" +
				"before publishing: go mod edit -module github.com/<owner>/code-foundry-plugin-hello",
			wantCode: 1,
		},
		{
			name:    "refused",
			args:    map[string]string{"name": "new", "dir": "/Users/a/src"},
			err:     fmt.Errorf("%w: plugin name %q: name: reserved", pluginscaffold.ErrInvalid, "new"),
			wantErr: connect.CodeInvalidArgument,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &commandtest.PluginScaffolder{Res: tt.res, Err: tt.err}
			reg := command.NewRegistry()
			if err := command.RegisterPluginNew(reg, f); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, "plugin.new", tt.args)
			if tt.wantErr != 0 {
				if connect.CodeOf(err) != tt.wantErr {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if f.Name != tt.args["name"] || f.Parent != tt.args["dir"] || f.Owner != tt.args["owner"] {
				t.Errorf("New(%q, %q, %q)", f.Name, f.Parent, f.Owner)
			}
			if res.Message != tt.want {
				t.Errorf("message =\n%s\nwant\n%s", res.Message, tt.want)
			}
			if res.ExitCode != tt.wantCode {
				t.Errorf("exit code %d, want %d", res.ExitCode, tt.wantCode)
			}
		})
	}
}

func TestPluginNewUnwired(t *testing.T) {
	reg := command.NewRegistry()
	if err := command.RegisterPluginNew(reg, nil); err != nil {
		t.Fatal(err)
	}
	_, err := reg.Invoke(context.Background(), command.Context{}, "plugin.new", map[string]string{"name": "hello", "dir": "/Users/a"})
	if connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("err = %v, want Unimplemented", err)
	}
}
