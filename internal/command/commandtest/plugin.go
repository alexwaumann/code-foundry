package commandtest

import (
	"context"
	"slices"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// Plugin is a fake command.PluginBackend over Plugins. Every call is recorded; Err, when
// set, is returned by every call. Enable and Dev answer needs_consent while the plugin's
// needs_consent is set and consent is not given; with consent they enable it.
type Plugin struct {
	Calls
	Err     error
	Plugins []*v1.Plugin
	// Lines is what Logs returns.
	Lines []*v1.PluginLogLine
	// Secrets is what ListSecrets returns.
	Secrets []*v1.PluginSecret
	// Envs is what Environment returns.
	Envs []*v1.PluginEnvironment
}

var _ command.PluginBackend = (*Plugin)(nil)

func (f *Plugin) do(m proto.Message) error {
	f.record(m)
	return f.Err
}

func (f *Plugin) find(name string) (*v1.Plugin, error) {
	i := slices.IndexFunc(f.Plugins, func(p *v1.Plugin) bool { return p.GetName() == name })
	if i < 0 {
		return nil, connect.NewError(connect.CodeNotFound, nil)
	}
	return f.Plugins[i], nil
}

// List returns Plugins.
func (f *Plugin) List(_ context.Context, r *connect.Request[v1.ListPluginsRequest]) (*connect.Response[v1.ListPluginsResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ListPluginsResponse{Plugins: f.Plugins}), nil
}

func (f *Plugin) enable(p *v1.Plugin, consent bool) (*v1.Plugin, bool) {
	if p.GetNeedsConsent() && !consent {
		return p, true
	}
	p.Enabled, p.NeedsConsent, p.State = true, false, v1.PluginState_PLUGIN_STATE_RUNNING
	return p, false
}

// Enable enables the plugin (see Plugin).
func (f *Plugin) Enable(_ context.Context, r *connect.Request[v1.EnablePluginRequest]) (*connect.Response[v1.EnablePluginResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	p, err := f.find(r.Msg.GetName())
	if err != nil {
		return nil, err
	}
	p, needs := f.enable(p, r.Msg.GetConsent())
	return connect.NewResponse(&v1.EnablePluginResponse{Plugin: p, NeedsConsent: needs, ConsentText: p.GetConsentText()}), nil
}

// Disable disables the plugin.
func (f *Plugin) Disable(_ context.Context, r *connect.Request[v1.DisablePluginRequest]) (*connect.Response[v1.DisablePluginResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	p, err := f.find(r.Msg.GetName())
	if err != nil {
		return nil, err
	}
	p.Enabled, p.State = false, v1.PluginState_PLUGIN_STATE_DISABLED
	return connect.NewResponse(&v1.DisablePluginResponse{Plugin: p}), nil
}

// Restart answers the plugin running.
func (f *Plugin) Restart(_ context.Context, r *connect.Request[v1.RestartPluginRequest]) (*connect.Response[v1.RestartPluginResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	p, err := f.find(r.Msg.GetName())
	if err != nil {
		return nil, err
	}
	p.State = v1.PluginState_PLUGIN_STATE_RUNNING
	return connect.NewResponse(&v1.RestartPluginResponse{Plugin: p}), nil
}

// Dev enables the first plugin whose dev_path is the request's path.
func (f *Plugin) Dev(_ context.Context, r *connect.Request[v1.DevPluginRequest]) (*connect.Response[v1.DevPluginResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	i := slices.IndexFunc(f.Plugins, func(p *v1.Plugin) bool { return p.GetDevPath() == r.Msg.GetPath() })
	if i < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, nil)
	}
	p := f.Plugins[i]
	if r.Msg.GetDryRun() {
		return connect.NewResponse(&v1.DevPluginResponse{Plugin: p, NeedsConsent: p.GetNeedsConsent(), ConsentText: p.GetConsentText()}), nil
	}
	p, needs := f.enable(p, r.Msg.GetConsent())
	return connect.NewResponse(&v1.DevPluginResponse{Plugin: p, NeedsConsent: needs, ConsentText: p.GetConsentText()}), nil
}

// Reload records the call.
func (f *Plugin) Reload(_ context.Context, r *connect.Request[v1.ReloadPluginsRequest]) (*connect.Response[v1.ReloadPluginsResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ReloadPluginsResponse{}), nil
}

// Logs returns Lines.
func (f *Plugin) Logs(_ context.Context, r *connect.Request[v1.PluginLogsRequest]) (*connect.Response[v1.PluginLogsResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.PluginLogsResponse{Lines: f.Lines, Path: "/logs/" + r.Msg.GetName() + ".log"}), nil
}

// ListSecrets returns Secrets.
func (f *Plugin) ListSecrets(_ context.Context, r *connect.Request[v1.ListPluginSecretsRequest]) (*connect.Response[v1.ListPluginSecretsResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ListPluginSecretsResponse{Secrets: f.Secrets}), nil
}

// DeleteSecret records the call.
func (f *Plugin) DeleteSecret(_ context.Context, r *connect.Request[v1.DeletePluginSecretRequest]) (*connect.Response[v1.DeletePluginSecretResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.DeletePluginSecretResponse{}), nil
}

// Environment returns Envs, or the one whose plugin is the request's name.
func (f *Plugin) Environment(_ context.Context, r *connect.Request[v1.PluginEnvironmentRequest]) (*connect.Response[v1.PluginEnvironmentResponse], error) {
	if err := f.do(r.Msg); err != nil {
		return nil, err
	}
	out := &v1.PluginEnvironmentResponse{}
	for _, e := range f.Envs {
		if r.Msg.GetName() == "" || e.GetPlugin() == r.Msg.GetName() {
			out.Environments = append(out.Environments, e)
		}
	}
	return connect.NewResponse(out), nil
}
