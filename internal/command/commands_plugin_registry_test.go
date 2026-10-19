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

func TestPluginRegistryCommands(t *testing.T) {
	hello := &v1.Plugin{Name: "hello", Version: "0.1.0", State: v1.PluginState_PLUGIN_STATE_DISABLED, Permissions: &v1.PluginPermissions{}}
	browse := &v1.BrowsePluginsResponse{Platform: "darwin/arm64",
		Entries: []*v1.PluginIndexEntry{
			{Name: "hello", DisplayName: "Hello", Version: "0.1.1", Description: "Greets.", Available: true, Registry: "https://github.com/o/reg",
				Permissions: &v1.PluginPermissions{Secrets: true}, PermissionLines: []string{"keep secrets"}, Installed: hello, UpdateAvailable: true,
				Relation: v1.PluginIndexRelation_PLUGIN_INDEX_RELATION_UPDATE},
			{Name: "jobs", DisplayName: "Jobs", Version: "1.0.0", Permissions: &v1.PluginPermissions{}},
		},
		Registries: []*v1.PluginRegistry{{Url: "https://github.com/o/reg", Plugins: 2, Cached: true, FetchedAt: timestamppb.Now()},
			{Url: "https://x.example/index.json", Error: "HTTP 502", Issues: []string{"plugins[0]: bad"}}},
	}
	tests := []struct {
		name      string
		cmd       string
		args      map[string]string
		confirmed bool
		browse    *v1.BrowsePluginsResponse // instead of the two-registry browse
		install   *v1.InstallPluginResponse
		update    *v1.UpdatePluginsResponse
		uninstall *v1.UninstallPluginResponse
		threads   []*v1.Thread // the plugin's threads, which the uninstall confirm counts
		wantErr   string       // a ConfirmError's message prefix, or a substring of the error
		wantMsg   []string
		want      proto.Message
	}{
		{name: "browse", cmd: "plugin.browse", args: map[string]string{"refresh": "true"}, want: &v1.BrowsePluginsRequest{Refresh: true},
			wantMsg: []string{"NAME   VERSION                        INSTALLED       PERMISSIONS  DESCRIPTION\nhello  0.1.1                          0.1.0 (update)  secrets      Greets.\njobs   1.0.0 (no darwin/arm64 build)  -               -\n", "registry https://github.com/o/reg: 2 plugin(s), fetched", "(cached)", "  error: HTTP 502", "  issue: plugins[0]: bad"}},
		{name: "browse names another source's install", cmd: "plugin.browse",
			browse: &v1.BrowsePluginsResponse{Platform: "darwin/arm64", Registries: []*v1.PluginRegistry{{Url: "https://github.com/o/reg"}},
				Entries: []*v1.PluginIndexEntry{{Name: "acme", Version: "2.0.0", Available: true, Permissions: &v1.PluginPermissions{},
					Installed: &v1.Plugin{Name: "acme", Version: "1.0.0"}, Relation: v1.PluginIndexRelation_PLUGIN_INDEX_RELATION_OTHER_SOURCE,
					InstalledFrom: "127.0.0.1:8765/index.json"}}},
			wantMsg: []string{"acme  2.0.0    1.0.0 (installed from 127.0.0.1:8765/index.json)  -"}},
		{name: "browse with no registry configured", cmd: "plugin.browse", browse: &v1.BrowsePluginsResponse{Platform: "darwin/arm64"},
			wantMsg: []string{"no plugin registry is configured; add one with: code-foundry settings set plugins.registries https://github.com/<owner>/<repo>"}},
		{name: "browse an empty registry", cmd: "plugin.browse",
			browse:  &v1.BrowsePluginsResponse{Platform: "darwin/arm64", Registries: []*v1.PluginRegistry{{Url: "https://github.com/o/reg"}}},
			wantMsg: []string{"no plugins in the registries\nregistry https://github.com/o/reg: 0 plugin(s)"}},
		{name: "install", cmd: "plugin.install", args: map[string]string{"ref": "hello"}, want: &v1.InstallPluginRequest{Ref: "hello"},
			install: &v1.InstallPluginResponse{Plugin: hello, Kind: "registry", Source: "https://github.com/o/reg", Version: "0.1.0", Changed: true, Warnings: []string{"unverified"}},
			wantMsg: []string{"installed hello 0.1.0 from https://github.com/o/reg\nwarning: unverified\ndisabled until you enable it: code-foundry plugin enable hello"}},
		{name: "install --enable asks with the entry's permissions", cmd: "plugin.install", args: map[string]string{"ref": "hello", "enable": "true"},
			wantErr: "Install and enable Hello 0.1.1 from https://github.com/o/reg? It runs as you and may:\n  - keep secrets"},
		{name: "install --enable of a release asks", cmd: "plugin.install", args: map[string]string{"ref": "o/hello", "enable": "true"},
			wantErr: "Install o/hello and enable it? Its permissions are only known after the download"},
		{name: "install --enable --yes", cmd: "plugin.install", args: map[string]string{"ref": "hello", "enable": "true", "force": "true"}, confirmed: true,
			want:    &v1.InstallPluginRequest{Ref: "hello", Enable: true, Consent: true, Force: true},
			install: &v1.InstallPluginResponse{Plugin: &v1.Plugin{Name: "hello", Version: "0.1.1", Enabled: true, State: v1.PluginState_PLUGIN_STATE_STARTING}, Source: "s", Version: "0.1.1", PreviousVersion: "0.1.0", Changed: true},
			wantMsg: []string{"updated hello 0.1.0 → 0.1.1 from s\nenabled hello 0.1.1 (starting)"}},
		{name: "install already", cmd: "plugin.install", args: map[string]string{"ref": "hello"},
			install: &v1.InstallPluginResponse{Plugin: hello, Version: "0.1.0"}, wantMsg: []string{"hello 0.1.0 is installed already (--force reinstalls it)"}},
		{name: "install link", cmd: "plugin.install", args: map[string]string{"ref": "/src/hello"},
			install: &v1.InstallPluginResponse{Plugin: hello, Kind: "path", Source: "/src/hello", Version: "0.1.0", Changed: true}, wantMsg: []string{"linked /src/hello as dev plugin hello 0.1.0"}},
		{name: "update check", cmd: "plugin.update", args: map[string]string{"check": "true"}, want: &v1.UpdatePluginsRequest{Check: true},
			update:  &v1.UpdatePluginsResponse{Updates: []*v1.PluginUpdate{{Name: "hello", CurrentVersion: "0.1.0", Version: "0.1.1", Registry: "r"}}},
			wantMsg: []string{"NAME   INSTALLED  AVAILABLE  REGISTRY\nhello  0.1.0      0.1.1      r\ninstall with: code-foundry plugin update [<name>]"}},
		{name: "update check with another source's newer version", cmd: "plugin.update", args: map[string]string{"check": "true"},
			update: &v1.UpdatePluginsResponse{Updates: []*v1.PluginUpdate{
				{Name: "hello", CurrentVersion: "0.1.0", Version: "0.1.1", Registry: "r"},
				{Name: "acme", CurrentVersion: "1.0.0", Version: "2.0.0", Registry: "https://github.com/o/reg", InstalledFrom: "127.0.0.1:8765/index.json"},
			}},
			wantMsg: []string{"NAME   INSTALLED  AVAILABLE  REGISTRY\nhello  0.1.0      0.1.1      r\ninstall with: code-foundry plugin update [<name>]\n" +
				"not offered: acme 2.0.0 from https://github.com/o/reg (installed from 127.0.0.1:8765/index.json; `code-foundry plugin install acme --force` switches to it, deleting its secrets, data and consent)"}},
		{name: "update with only another source's", cmd: "plugin.update", args: map[string]string{"name": "acme"},
			update: &v1.UpdatePluginsResponse{Updates: []*v1.PluginUpdate{
				{Name: "acme", CurrentVersion: "1.0.0", Version: "2.0.0", Registry: "https://github.com/o/reg", InstalledFrom: "127.0.0.1:8765/index.json"},
			}},
			wantMsg: []string{"every plugin is up to date\nnot offered: acme 2.0.0 from https://github.com/o/reg (installed from 127.0.0.1:8765/index.json;"}},
		{name: "update none", cmd: "plugin.update", wantMsg: []string{"every plugin is up to date"}},
		{name: "update", cmd: "plugin.update", args: map[string]string{"name": "hello"}, want: &v1.UpdatePluginsRequest{Name: "hello"},
			update: &v1.UpdatePluginsResponse{Updates: []*v1.PluginUpdate{
				{Name: "hello", CurrentVersion: "0.1.0", Version: "0.1.1", Updated: true, DisabledReason: "its permissions changed"},
				{Name: "jobs", Version: "2.0.0", Error: "sha256 mismatch"},
			}},
			wantMsg: []string{"updated hello 0.1.0 → 0.1.1; disabled: its permissions changed (code-foundry plugin enable hello)\njobs: update to 2.0.0 failed: sha256 mismatch"}},
		{name: "uninstall asks", cmd: "plugin.uninstall", args: map[string]string{"name": "hello"}, wantErr: "Uninstall plugin hello? Its data, secrets and consent stay"},
		{name: "uninstall purge asks", cmd: "plugin.uninstall", args: map[string]string{"name": "hello", "purge": "true"}, wantErr: "Uninstall plugin hello and delete its data"},
		{name: "uninstall", cmd: "plugin.uninstall", args: map[string]string{"name": "hello", "purge": "true"}, confirmed: true,
			want: &v1.UninstallPluginRequest{Name: "hello", Purge: true}, wantMsg: []string{"uninstalled hello"}},
		{name: "uninstall asks with the threads it removes", cmd: "plugin.uninstall", args: map[string]string{"name": "hello"},
			threads: []*v1.Thread{{Id: "s-1"}, {Id: "s-2"}},
			wantErr: "Uninstall plugin hello? It removes its 2 threads; its data, secrets and consent stay (--purge deletes them)."},
		{name: "uninstall purge asks with the thread it removes", cmd: "plugin.uninstall", args: map[string]string{"name": "hello", "purge": "true"},
			threads: []*v1.Thread{{Id: "s-1"}},
			wantErr: "Uninstall plugin hello? It removes its 1 thread and deletes its data, its secrets in the Keychain, its logs and the consent given."},
		{name: "uninstall reports the threads removed", cmd: "plugin.uninstall", args: map[string]string{"name": "hello"}, confirmed: true,
			uninstall: &v1.UninstallPluginResponse{Removed: "/p/hello", RemovedThreadIds: []string{"s-1", "s-2"}},
			wantMsg:   []string{"uninstalled hello (removed /p/hello)\nremoved its 2 threads: s-1, s-2"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			br := browse
			if tt.browse != nil {
				br = tt.browse
			}
			b := &commandtest.PluginRegistry{BrowseRes: br, InstallRes: tt.install, UpdateRes: tt.update, UninstallRes: tt.uninstall}
			reg := command.NewRegistry()
			if err := command.RegisterPluginRegistry(reg, b, &commandtest.Thread{Others: tt.threads}); err != nil {
				t.Fatal(err)
			}
			var opts []command.InvokeOption
			if tt.confirmed {
				opts = append(opts, command.Confirmed(true))
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, tt.cmd, tt.args, opts...)
			if tt.wantErr != "" {
				var ce *command.ConfirmError
				if !errors.As(err, &ce) || !strings.HasPrefix(ce.Message, tt.wantErr) {
					t.Fatalf("err = %v, want confirm %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, w := range tt.wantMsg {
				if !strings.Contains(res.Message, w) {
					t.Errorf("message:\n%s\nwant:\n%s", res.Message, w)
				}
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
