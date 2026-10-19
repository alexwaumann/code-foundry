package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/plugintest"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// installFake is plugintest.Fake plus the registry half (plugin.Installer).
type installFake struct {
	*plugintest.Fake
	browse plugin.BrowseResult
	got    []any
}

func (f *installFake) Browse(_ context.Context, refresh bool) (plugin.BrowseResult, error) {
	f.got = append(f.got, refresh)
	return f.browse, nil
}

func (f *installFake) Install(_ context.Context, req plugin.InstallRequest) (plugin.InstallResult, error) {
	f.got = append(f.got, req)
	p := helloPlugin()
	return plugin.InstallResult{Plugin: p, Kind: plugin.KindRegistry, Source: "https://github.com/o/reg", Version: "0.1.0", Changed: true, Warnings: []string{"w"}}, nil
}

func (f *installFake) Update(_ context.Context, name string, check, refresh bool) ([]plugin.PluginUpdate, error) {
	f.got = append(f.got, []any{name, check, refresh})
	return []plugin.PluginUpdate{
		{Name: "hello", Current: "0.1.0", Version: "0.2.0", Registry: "r", Updated: true, Disabled: "grew"},
		{Name: "other", Current: "1.0.0", Version: "2.0.0", Registry: "r2", InstalledFrom: "o/reg"},
	}, nil
}

func (f *installFake) Uninstall(_ context.Context, name string, purge bool) (plugin.UninstallResult, error) {
	f.got = append(f.got, []any{name, purge})
	return plugin.UninstallResult{Removed: "/p/hello", Purged: []string{"its logs"}}, nil
}

func newRegistryServer(t *testing.T, store plugin.Store) codefoundryv1connect.PluginServiceClient {
	t.Helper()
	route := NewPlugin(store, bus.New()).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return codefoundryv1connect.NewPluginServiceClient(srv.Client(), srv.URL)
}

func TestPluginRegistryService(t *testing.T) {
	ctx := context.Background()
	installed := helloPlugin()
	installed.Installed = &plugin.InstallRecord{Kind: plugin.KindRegistry, Source: "https://github.com/o/reg", Version: "0.1.0", SHA256: "abc", InstalledAt: time.Unix(10, 0)}
	installed.Update = &plugin.UpdateOffer{Version: "0.2.0", Registry: "https://github.com/o/reg"}
	f := &installFake{Fake: plugintest.New(nil), browse: plugin.BrowseResult{
		Entries: []plugin.BrowseEntry{{Entry: registry.Entry{
			Name: "hello", DisplayName: "Hello", Version: "0.2.0", Repo: "o/hello", Protocol: 1, Registry: "https://github.com/o/reg",
			Permissions: pluginsdk.Permissions{Secrets: true},
			Artifacts:   map[string]registry.Artifact{registry.Platform(): {URL: "https://x/h.tgz", SHA256: "s"}, "linux/riscv": {URL: "u", SHA256: "t"}},
		}, Installed: &installed, Relation: plugin.RelationUpdate}, {Entry: registry.Entry{
			// Newer than what is installed, but another registry's: no update.
			Name: "other", Version: "9.0.0", Protocol: 1, Registry: "http://127.0.0.1:9/index.json",
		}, Installed: &installed, Relation: plugin.RelationOtherSource, InstalledFrom: "o/reg"}},
		Registries: []registry.Status{{URL: "https://github.com/o/reg", Plugins: 1, Cached: true, FetchedAt: time.Unix(20, 0)}},
	}}
	f.Put(installed)
	c := newRegistryServer(t, f)

	br, err := c.Browse(ctx, connect.NewRequest(&v1.BrowsePluginsRequest{Refresh: true}))
	if err != nil {
		t.Fatal(err)
	}
	e := br.Msg.GetEntries()[0]
	if br.Msg.GetPlatform() != registry.Platform() || e.GetName() != "hello" || !e.GetAvailable() || !e.GetUpdateAvailable() ||
		e.GetInstalled().GetVersion() != "0.1.0" || len(e.GetArtifacts()) != 2 || e.GetArtifacts()[0].GetPlatform() != registry.Platform() ||
		len(e.GetPermissionLines()) != 1 || !e.GetPermissions().GetSecrets() {
		t.Errorf("entry = %v", e)
	}
	if e.GetRelation() != v1.PluginIndexRelation_PLUGIN_INDEX_RELATION_UPDATE || e.GetInstalledFrom() != "" {
		t.Errorf("relation = %v from %q", e.GetRelation(), e.GetInstalledFrom())
	}
	if o := br.Msg.GetEntries()[1]; o.GetRelation() != v1.PluginIndexRelation_PLUGIN_INDEX_RELATION_OTHER_SOURCE ||
		o.GetUpdateAvailable() || o.GetInstalledFrom() != "o/reg" {
		t.Errorf("other source entry = %v", o)
	}
	if r := br.Msg.GetRegistries()[0]; !r.GetCached() || r.GetPlugins() != 1 || r.GetFetchedAt().AsTime().Unix() != 20 {
		t.Errorf("registry = %v", r)
	}
	// The plugin carries its install record and offer.
	list, _ := c.List(ctx, connect.NewRequest(&v1.ListPluginsRequest{}))
	p := list.Msg.GetPlugins()[0]
	if p.GetInstall().GetKind() != "registry" || p.GetInstall().GetSha256() != "abc" || !p.GetUpdateAvailable() || p.GetUpdateVersion() != "0.2.0" {
		t.Errorf("plugin = %v", p)
	}
	ins, err := c.Install(ctx, connect.NewRequest(&v1.InstallPluginRequest{Ref: "hello", Enable: true, Consent: true, Force: true, Refresh: true}))
	if err != nil || ins.Msg.GetVersion() != "0.1.0" || !ins.Msg.GetChanged() || ins.Msg.GetKind() != "registry" || ins.Msg.GetWarnings()[0] != "w" {
		t.Errorf("install = %v, %v", ins, err)
	}
	if got := f.got[1].(plugin.InstallRequest); got != (plugin.InstallRequest{Ref: "hello", Enable: true, Consent: true, Force: true, Refresh: true}) {
		t.Errorf("install request = %+v", got)
	}
	up, err := c.Update(ctx, connect.NewRequest(&v1.UpdatePluginsRequest{Name: "hello", Check: true}))
	if err != nil || up.Msg.GetUpdates()[0].GetDisabledReason() != "grew" || !up.Msg.GetUpdates()[0].GetUpdated() ||
		up.Msg.GetUpdates()[1].GetInstalledFrom() != "o/reg" {
		t.Errorf("update = %v, %v", up, err)
	}
	un, err := c.Uninstall(ctx, connect.NewRequest(&v1.UninstallPluginRequest{Name: "hello", Purge: true}))
	if err != nil || un.Msg.GetRemoved() != "/p/hello" || un.Msg.GetPurged()[0] != "its logs" {
		t.Errorf("uninstall = %v, %v", un, err)
	}
	if _, err := c.RefreshRegistries(ctx, connect.NewRequest(&v1.RefreshPluginRegistriesRequest{})); err != nil {
		t.Error(err)
	}

	// A store without the registry half answers Unimplemented.
	plain := newRegistryServer(t, plugintest.New(nil))
	if _, err := plain.Browse(ctx, connect.NewRequest(&v1.BrowsePluginsRequest{})); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("plain browse err = %v", err)
	}
}

func TestRegistryEventsToProto(t *testing.T) {
	ev := pluginEventToProto(plugin.InstallProgress{Ref: "hello", Name: "hello", Version: "0.1.0", Phase: plugin.InstallVerifying, Message: "m", Bytes: 3})
	if p := ev.GetInstallProgress(); p.GetPhase() != v1.PluginInstallPhase_PLUGIN_INSTALL_PHASE_VERIFYING || p.GetBytes() != 3 || p.GetName() != "hello" {
		t.Errorf("progress = %v", ev)
	}
	if ev := pluginEventToProto(plugin.RegistryChanged{Epoch: 4}); ev.GetRegistryEpoch() != 4 {
		t.Errorf("registry = %v", ev)
	}
}
