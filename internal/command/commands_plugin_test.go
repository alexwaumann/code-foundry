package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func pluginFixture(t *testing.T) (*command.Registry, *commandtest.Plugin) {
	t.Helper()
	b := &commandtest.Plugin{Plugins: []*v1.Plugin{
		{Name: "hello", Version: "0.1.0", State: v1.PluginState_PLUGIN_STATE_DISABLED, NeedsConsent: true,
			ConsentText: "Enable Hello 0.1.0? It runs bin/hello as you and may:\n  - keep secrets", DevPath: "/src/hello",
			Permissions: &v1.PluginPermissions{Commands: []string{"thread.send"}, Secrets: true},
			Commands:    []*v1.PluginCommand{{Name: "plugin.hello.greet", Title: "Greet"}}},
		{Name: "quiet", Version: "1.0.0", State: v1.PluginState_PLUGIN_STATE_DISABLED, Permissions: &v1.PluginPermissions{},
			UpdateAvailable: true, UpdateVersion: "1.1.0",
			Surfaces: []*v1.PluginSurface{{Id: "runs", Available: true}, {Id: "checks", Unknown: true}, {Id: "logs"}}},
	}}
	reg := command.NewRegistry()
	if err := command.RegisterPlugin(reg, b); err != nil {
		t.Fatal(err)
	}
	return reg, b
}

func TestPluginCommands(t *testing.T) {
	tests := []struct {
		name      string
		cmd       string
		args      map[string]string
		confirmed bool
		wantErr   string // a ConfirmError's message, or a substring of the error
		wantMsg   string // substring
		want      proto.Message
	}{
		{name: "list", cmd: "plugin.list", wantMsg: "hello  0.1.0    disabled  commands(thread.send) secrets  1         -                                   new: code-foundry plugin enable hello"},
		{name: "list offers updates", cmd: "plugin.list", wantMsg: "1.1.0 available: code-foundry plugin update quiet"},
		{name: "list says unknown for a clause not known yet", cmd: "plugin.list", wantMsg: "runs(on) checks(unknown) logs(off)"},
		{name: "enable asks for consent", cmd: "plugin.enable", args: map[string]string{"name": "hello"},
			wantErr: "Enable Hello 0.1.0? It runs bin/hello as you and may:\n  - keep secrets"},
		{name: "enable with consent", cmd: "plugin.enable", args: map[string]string{"name": "hello"}, confirmed: true,
			wantMsg: "enabled hello 0.1.0 (running)\ncommands: code-foundry plugin hello greet", want: &v1.EnablePluginRequest{Name: "hello", Consent: true}},
		{name: "enable without needed consent", cmd: "plugin.enable", args: map[string]string{"name": "quiet"},
			wantMsg: "enabled quiet 1.0.0 (running)", want: &v1.EnablePluginRequest{Name: "quiet", Consent: true}},
		{name: "enable unknown runs and fails", cmd: "plugin.enable", args: map[string]string{"name": "nope"}, wantErr: "not_found"},
		{name: "disable", cmd: "plugin.disable", args: map[string]string{"name": "hello"}, wantMsg: "disabled hello", want: &v1.DisablePluginRequest{Name: "hello"}},
		{name: "restart", cmd: "plugin.restart", args: map[string]string{"name": "hello"}, wantMsg: "restarted hello (running)"},
		{name: "logs", cmd: "plugin.logs", args: map[string]string{"name": "hello"}, wantMsg: "stderr     boom\nlog file: /logs/hello.log",
			want: &v1.PluginLogsRequest{Name: "hello", Lines: 50}},
		{name: "logs follow prints nothing", cmd: "plugin.logs", args: map[string]string{"name": "hello", "follow": "true"}},
		{name: "dev asks", cmd: "plugin.dev", args: map[string]string{"path": "/src/hello"}, wantErr: "Enable Hello 0.1.0?"},
		{name: "dev", cmd: "plugin.dev", args: map[string]string{"path": "/src/hello"}, confirmed: true,
			wantMsg: "linked /src/hello as dev plugin hello; enabled hello", want: &v1.DevPluginRequest{Path: "/src/hello", Consent: true}},
		{name: "secrets list", cmd: "plugin.secrets.list", args: map[string]string{"name": "hello"}, wantMsg: "KEY    SET\ntoken  "},
		{name: "secrets delete asks", cmd: "plugin.secrets.delete", args: map[string]string{"name": "hello", "key": "token"},
			wantErr: "Delete secret token of plugin hello from the Keychain?"},
		{name: "secrets delete", cmd: "plugin.secrets.delete", args: map[string]string{"name": "hello", "key": "token"}, confirmed: true,
			wantMsg: "deleted secret token of plugin hello", want: &v1.DeletePluginSecretRequest{Name: "hello", Key: "token"}},
		{name: "reload", cmd: "plugin.reload", wantMsg: "rescanned"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b := pluginFixture(t)
			b.Lines = []*v1.PluginLogLine{{Seq: 1, Time: timestamppb.Now(), Source: "stderr", Text: "boom"}}
			b.Secrets = []*v1.PluginSecret{{Key: "token", UpdatedAt: timestamppb.Now()}}
			var opts []command.InvokeOption
			if tt.confirmed {
				opts = append(opts, command.Confirmed(true))
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, tt.cmd, tt.args, opts...)
			if tt.wantErr != "" {
				var ce *command.ConfirmError
				if errors.As(err, &ce) {
					if ce.Message != tt.wantErr && !strings.HasPrefix(ce.Message, tt.wantErr) {
						t.Fatalf("confirm %q, want %q", ce.Message, tt.wantErr)
					}
					return
				}
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(res.Message, tt.wantMsg) {
				t.Errorf("message %q, want %q", res.Message, tt.wantMsg)
			}
			if tt.wantMsg == "" && res.Message != "" {
				t.Errorf("message %q, want none", res.Message)
			}
			if tt.want != nil {
				reqs := b.Requests()
				if !proto.Equal(reqs[len(reqs)-1], tt.want) {
					t.Errorf("request %v, want %v", reqs[len(reqs)-1], tt.want)
				}
			}
		})
	}
}
