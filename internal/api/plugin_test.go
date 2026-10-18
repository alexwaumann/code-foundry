package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

func newPluginServer(t *testing.T) (*plugintest.Fake, codefoundryv1connect.PluginServiceClient) {
	t.Helper()
	b := bus.New()
	fake := plugintest.New(b)
	route := NewPlugin(fake, b).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return fake, codefoundryv1connect.NewPluginServiceClient(srv.Client(), srv.URL)
}

func helloPlugin() plugin.Plugin {
	return plugin.Plugin{
		Name: "hello", State: plugin.StateDisabled, NeedsConsent: true, LogPath: "/logs/hello.log",
		Manifest: pluginsdk.Manifest{
			Name: "hello", DisplayName: "Hello", Version: "0.1.0", Protocol: 1, Exec: []string{"bin/hello"},
			Permissions: pluginsdk.Permissions{Commands: []string{"thread.send"}, Secrets: true},
			Commands:    []pluginsdk.CommandSpec{{Name: "greet", Title: "Greet"}},
			Surfaces:    []pluginsdk.SurfaceSpec{{ID: "main", Title: "Hello", Scope: "thread", Placement: []string{"panel"}}},
		},
	}
}

func TestPluginService(t *testing.T) {
	fake, c := newPluginServer(t)
	ctx := context.Background()
	fake.Put(helloPlugin())

	list, err := c.List(ctx, connect.NewRequest(&v1.ListPluginsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	p := list.Msg.GetPlugins()[0]
	if p.GetName() != "hello" || p.GetDisplayName() != "Hello" || p.GetState() != v1.PluginState_PLUGIN_STATE_DISABLED ||
		!p.GetNeedsConsent() || p.GetGranted() != nil || !p.GetPermissions().GetSecrets() ||
		p.GetCommands()[0].GetName() != "plugin.hello.greet" || p.GetSurfaces()[0].GetId() != "main" ||
		!strings.Contains(p.GetConsentText(), "run Code Foundry commands: thread.send") {
		t.Fatalf("List = %v", p)
	}

	res, err := c.Enable(ctx, connect.NewRequest(&v1.EnablePluginRequest{Name: "hello"}))
	if err != nil || !res.Msg.GetNeedsConsent() || res.Msg.GetConsentText() == "" {
		t.Fatalf("Enable without consent = %v, %v", res, err)
	}
	res, err = c.Enable(ctx, connect.NewRequest(&v1.EnablePluginRequest{Name: "hello", Consent: true}))
	if err != nil || res.Msg.GetNeedsConsent() || res.Msg.GetPlugin().GetState() != v1.PluginState_PLUGIN_STATE_RUNNING ||
		!res.Msg.GetPlugin().GetGranted().GetSecrets() {
		t.Fatalf("Enable = %v, %v", res, err)
	}
	if _, err := c.Enable(ctx, connect.NewRequest(&v1.EnablePluginRequest{Name: "nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("Enable unknown: %v", err)
	}
	if r, err := c.Restart(ctx, connect.NewRequest(&v1.RestartPluginRequest{Name: "hello"})); err != nil || r.Msg.GetPlugin().GetName() != "hello" {
		t.Errorf("Restart = %v, %v", r, err)
	}
	if r, err := c.Disable(ctx, connect.NewRequest(&v1.DisablePluginRequest{Name: "hello"})); err != nil || r.Msg.GetPlugin().GetEnabled() {
		t.Errorf("Disable = %v, %v", r, err)
	}

	fake.AddLog("hello", plugin.LogLine{Seq: 1, Time: time.UnixMilli(5), Source: "stderr", Text: "a"},
		plugin.LogLine{Seq: 2, Time: time.UnixMilli(6), Source: "log", Level: "info", Text: "b"})
	logs, err := c.Logs(ctx, connect.NewRequest(&v1.PluginLogsRequest{Name: "hello", Lines: 1}))
	if err != nil || len(logs.Msg.GetLines()) != 1 || logs.Msg.GetLines()[0].GetText() != "b" || logs.Msg.GetPath() != "/logs/hello.log" {
		t.Fatalf("Logs = %v, %v", logs, err)
	}

	fctx, cancel := context.WithCancel(ctx)
	stream, err := c.FollowLogs(fctx, connect.NewRequest(&v1.FollowPluginLogsRequest{Name: "hello", Lines: 2}))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for len(got) < 2 && stream.Receive() {
		got = append(got, stream.Msg().GetText())
	}
	cancel()
	_ = stream.Close()
	if strings.Join(got, ",") != "a,b" {
		t.Errorf("FollowLogs = %q", got)
	}

	fake.PutSecret("hello", "token")
	sec, err := c.ListSecrets(ctx, connect.NewRequest(&v1.ListPluginSecretsRequest{Name: "hello"}))
	if err != nil || len(sec.Msg.GetSecrets()) != 1 || sec.Msg.GetSecrets()[0].GetKey() != "token" {
		t.Fatalf("ListSecrets = %v, %v", sec, err)
	}
	if _, err := c.DeleteSecret(ctx, connect.NewRequest(&v1.DeletePluginSecretRequest{Name: "hello", Key: "token"})); err != nil {
		t.Fatal(err)
	}
	if _, err := c.DeleteSecret(ctx, connect.NewRequest(&v1.DeletePluginSecretRequest{Name: "hello", Key: "token"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("DeleteSecret twice: %v", err)
	}
}

func TestPluginWatch(t *testing.T) {
	fake, c := newPluginServer(t)
	fake.Put(helloPlugin())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchPluginsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	if !stream.Receive() || len(stream.Msg().GetSnapshot().GetPlugins()) != 1 {
		t.Fatalf("first = %v, %v", stream.Msg(), stream.Err())
	}
	p := helloPlugin()
	p.State = plugin.StateCrashed
	fake.Put(p)
	if !stream.Receive() || stream.Msg().GetUpdated().GetState() != v1.PluginState_PLUGIN_STATE_CRASHED {
		t.Fatalf("update = %v, %v", stream.Msg(), stream.Err())
	}
}

func TestPluginListDirs(t *testing.T) {
	b := bus.New()
	fake := plugintest.New(b)
	for _, tc := range []struct {
		name          string
		h             *Plugin
		plugins, data string
	}{
		{"unset", NewPlugin(fake, b), "", ""},
		{"set", NewPlugin(fake, b).WithDirs("/home/u/.cf/plugins", "/home/u/.cf/plugin-data"), "/home/u/.cf/plugins", "/home/u/.cf/plugin-data"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res, err := tc.h.List(context.Background(), connect.NewRequest(&v1.ListPluginsRequest{}))
			if err != nil {
				t.Fatal(err)
			}
			if got := res.Msg.GetPluginsDir(); got != tc.plugins {
				t.Errorf("plugins_dir = %q, want %q", got, tc.plugins)
			}
			if got := res.Msg.GetDataDir(); got != tc.data {
				t.Errorf("data_dir = %q, want %q", got, tc.data)
			}
		})
	}
}
