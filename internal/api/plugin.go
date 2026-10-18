package api

import (
	"context"
	"errors"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Plugin implements codefoundryv1connect.PluginServiceHandler over a plugin.Store.
type Plugin struct {
	store    plugin.Store
	bus      *bus.Bus
	surfaces plugin.Surfaces // nil: WatchSurface, GetSurface and Act are unimplemented
	beat     time.Duration   // WatchSurface's heartbeat interval; zero is HeartbeatInterval
}

var _ codefoundryv1connect.PluginServiceHandler = (*Plugin)(nil)

// NewPlugin returns a PluginService handler. b must be the bus the store publishes
// plugin.Event on.
func NewPlugin(store plugin.Store, b *bus.Bus) *Plugin { return &Plugin{store: store, bus: b} }

// Route mounts the service.
func (h *Plugin) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewPluginServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// List returns every plugin, with each surface's availability in the request's context.
func (h *Plugin) List(_ context.Context, req *connect.Request[v1.ListPluginsRequest]) (*connect.Response[v1.ListPluginsResponse], error) {
	out := pluginsToProto(h.store.Snapshot().Plugins)
	h.fillAvailability(out, contextFromProto(req.Msg.GetContext()))
	return connect.NewResponse(&v1.ListPluginsResponse{Plugins: out}), nil
}

// Enable turns a plugin on, or reports the consent it needs.
func (h *Plugin) Enable(ctx context.Context, req *connect.Request[v1.EnablePluginRequest]) (*connect.Response[v1.EnablePluginResponse], error) {
	res, err := h.store.Enable(ctx, req.Msg.GetName(), req.Msg.GetConsent())
	if err != nil {
		return nil, pluginError(err)
	}
	return connect.NewResponse(&v1.EnablePluginResponse{
		Plugin: pluginToProto(res.Plugin), NeedsConsent: res.NeedsConsent, ConsentText: res.Consent,
	}), nil
}

// Disable stops a plugin.
func (h *Plugin) Disable(ctx context.Context, req *connect.Request[v1.DisablePluginRequest]) (*connect.Response[v1.DisablePluginResponse], error) {
	p, err := h.store.Disable(ctx, req.Msg.GetName())
	if err != nil {
		return nil, pluginError(err)
	}
	return connect.NewResponse(&v1.DisablePluginResponse{Plugin: pluginToProto(p)}), nil
}

// Restart starts a plugin afresh.
func (h *Plugin) Restart(ctx context.Context, req *connect.Request[v1.RestartPluginRequest]) (*connect.Response[v1.RestartPluginResponse], error) {
	p, err := h.store.Restart(ctx, req.Msg.GetName())
	if err != nil {
		return nil, pluginError(err)
	}
	return connect.NewResponse(&v1.RestartPluginResponse{Plugin: pluginToProto(p)}), nil
}

// Dev links a plugin folder and enables it.
func (h *Plugin) Dev(ctx context.Context, req *connect.Request[v1.DevPluginRequest]) (*connect.Response[v1.DevPluginResponse], error) {
	m := req.Msg
	res, err := h.store.Dev(ctx, m.GetPath(), m.GetConsent(), m.GetDryRun())
	if err != nil {
		return nil, pluginError(err)
	}
	return connect.NewResponse(&v1.DevPluginResponse{
		Plugin: pluginToProto(res.Plugin), NeedsConsent: res.NeedsConsent, ConsentText: res.Consent,
	}), nil
}

// Reload rescans the plugins directory.
func (h *Plugin) Reload(ctx context.Context, _ *connect.Request[v1.ReloadPluginsRequest]) (*connect.Response[v1.ReloadPluginsResponse], error) {
	if err := h.store.Reload(ctx); err != nil {
		return nil, pluginError(err)
	}
	return connect.NewResponse(&v1.ReloadPluginsResponse{}), nil
}

// Logs returns a plugin's log tail.
func (h *Plugin) Logs(_ context.Context, req *connect.Request[v1.PluginLogsRequest]) (*connect.Response[v1.PluginLogsResponse], error) {
	name := req.Msg.GetName()
	lines, err := h.store.Logs(name, int(req.Msg.GetLines()))
	if err != nil {
		return nil, pluginError(err)
	}
	out := &v1.PluginLogsResponse{}
	if p, ok := h.store.Snapshot().Plugin(name); ok {
		out.Path = p.LogPath
	}
	for _, l := range lines {
		out.Lines = append(out.Lines, pluginLogLineToProto(l))
	}
	return connect.NewResponse(out), nil
}

// FollowLogs streams a plugin's log.
func (h *Plugin) FollowLogs(ctx context.Context, req *connect.Request[v1.FollowPluginLogsRequest], stream *connect.ServerStream[v1.PluginLogLine]) error {
	ch, err := h.store.FollowLogs(ctx, req.Msg.GetName(), int(req.Msg.GetLines()))
	if err != nil {
		return pluginError(err)
	}
	// Flush the headers now: the first line may be a long way off.
	if err := stream.Send(nil); err != nil {
		return err
	}
	for l := range ch {
		if err := stream.Send(pluginLogLineToProto(l)); err != nil {
			return err
		}
	}
	return nil
}

// ListSecrets returns a plugin's secret names.
func (h *Plugin) ListSecrets(ctx context.Context, req *connect.Request[v1.ListPluginSecretsRequest]) (*connect.Response[v1.ListPluginSecretsResponse], error) {
	list, err := h.store.Secrets(ctx, req.Msg.GetName())
	if err != nil {
		return nil, pluginError(err)
	}
	out := &v1.ListPluginSecretsResponse{}
	for _, s := range list {
		out.Secrets = append(out.Secrets, &v1.PluginSecret{Key: s.Key, UpdatedAt: timestamppb.New(s.UpdatedAt)})
	}
	return connect.NewResponse(out), nil
}

// DeleteSecret removes one secret.
func (h *Plugin) DeleteSecret(ctx context.Context, req *connect.Request[v1.DeletePluginSecretRequest]) (*connect.Response[v1.DeletePluginSecretResponse], error) {
	if err := h.store.DeleteSecret(ctx, req.Msg.GetName(), req.Msg.GetKey()); err != nil {
		return nil, pluginError(err)
	}
	return connect.NewResponse(&v1.DeletePluginSecretResponse{}), nil
}

// Watch sends a snapshot, then every change.
func (h *Plugin) Watch(ctx context.Context, _ *connect.Request[v1.WatchPluginsRequest], stream *connect.ServerStream[v1.PluginEvent]) error {
	sub := bus.Subscribe[plugin.Event](h.bus, watchBuffer)
	defer sub.Close()
	if err := stream.Send(pluginEventToProto(h.store.Snapshot())); err != nil {
		return err
	}
	var dropped uint64
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-sub.C():
			if !ok {
				return nil
			}
			if d := sub.Dropped(); d != dropped {
				dropped = d
				ev = h.store.Snapshot()
			}
			if msg := pluginEventToProto(ev); msg != nil {
				if err := stream.Send(msg); err != nil {
					return err
				}
			}
		}
	}
}

// pluginEventToProto converts a bus event (or a *plugin.Snapshot) to the wire event.
func pluginEventToProto(ev plugin.Event) *v1.PluginEvent {
	switch e := ev.(type) {
	case *plugin.Snapshot:
		return &v1.PluginEvent{Event: &v1.PluginEvent_Snapshot{Snapshot: &v1.PluginSnapshot{Plugins: pluginsToProto(e.Plugins)}}}
	case plugin.Changed:
		return &v1.PluginEvent{Event: &v1.PluginEvent_Updated{Updated: pluginToProto(e.Plugin)}}
	case plugin.Removed:
		return &v1.PluginEvent{Event: &v1.PluginEvent_RemovedName{RemovedName: e.Name}}
	case plugin.AvailabilityChanged:
		return &v1.PluginEvent{Event: &v1.PluginEvent_AvailabilityEpoch{AvailabilityEpoch: e.Epoch}}
	}
	return nil
}

var pluginStates = map[plugin.State]v1.PluginState{
	plugin.StateDisabled: v1.PluginState_PLUGIN_STATE_DISABLED,
	plugin.StateStarting: v1.PluginState_PLUGIN_STATE_STARTING,
	plugin.StateRunning:  v1.PluginState_PLUGIN_STATE_RUNNING,
	plugin.StateCrashed:  v1.PluginState_PLUGIN_STATE_CRASHED,
	plugin.StateStopping: v1.PluginState_PLUGIN_STATE_STOPPING,
	plugin.StateStopped:  v1.PluginState_PLUGIN_STATE_STOPPED,
	plugin.StateFailed:   v1.PluginState_PLUGIN_STATE_FAILED,
}

func pluginsToProto(ps []plugin.Plugin) []*v1.Plugin {
	out := make([]*v1.Plugin, len(ps))
	for i, p := range ps {
		out[i] = pluginToProto(p)
	}
	return out
}

func permissionsToProto(p pluginsdk.Permissions) *v1.PluginPermissions {
	return &v1.PluginPermissions{
		Commands: p.Commands, Events: p.Events, ThreadStatus: p.ThreadStatus, SessionEnv: p.SessionEnv,
		Secrets: p.Secrets, Threads: p.Threads, Terminals: p.Terminals, Api: p.API,
	}
}

func optionalTime(t time.Time) *timestamppb.Timestamp {
	if t.IsZero() {
		return nil
	}
	return timestamppb.New(t)
}

func pluginToProto(p plugin.Plugin) *v1.Plugin {
	mf := p.Manifest
	out := &v1.Plugin{
		Name: p.Name, DisplayName: p.DisplayName(), Version: mf.Version, Description: mf.Description,
		State: pluginStates[p.State], Enabled: p.Enabled, DisabledReason: p.DisabledReason,
		Dev: p.Dev, DevPath: p.DevPath, Dir: p.Dir, LastError: p.LastError, Issues: p.Issues,
		Permissions: permissionsToProto(mf.Permissions), ConsentedAt: optionalTime(p.ConsentedAt),
		NeedsConsent: p.NeedsConsent, Pid: int32(p.PID), StartedAt: optionalTime(p.StartedAt),
		NextRestartAt: optionalTime(p.NextRestartAt), Restarts: int32(p.Restarts), Protocol: int32(p.Protocol),
		Capabilities: p.Capabilities, LogPath: p.LogPath,
	}
	if mf.Name != "" {
		out.ConsentText = plugin.ConsentText(mf)
	}
	if p.Granted != nil {
		out.Granted = permissionsToProto(*p.Granted)
	}
	for _, c := range mf.Commands {
		out.Commands = append(out.Commands, &v1.PluginCommand{Name: plugin.Prefix(p.Name) + c.Name, Title: c.Title, Description: c.Description})
	}
	for _, s := range mf.Surfaces {
		scope, placements := s.Scope, s.Placement
		if scope == "" {
			scope = pluginsdk.ScopeThread
		}
		if len(placements) == 0 {
			placements = []string{pluginsdk.PlacementPanel}
		}
		out.Surfaces = append(out.Surfaces, &v1.PluginSurface{Id: s.ID, Title: s.Title, Icon: s.Icon, Scope: scope, Placements: placements,
			When: s.When, ShowCommand: plugin.ShowCommand(p.Name, s.ID), Kind: plugin.SurfaceKind(p.Name, s.ID)})
	}
	return out
}

func pluginLogLineToProto(l plugin.LogLine) *v1.PluginLogLine {
	return &v1.PluginLogLine{Seq: l.Seq, Time: timestamppb.New(l.Time), Source: l.Source, Level: l.Level, Text: l.Text}
}

func pluginError(err error) error {
	code := connect.CodeInternal
	switch {
	case errors.Is(err, plugin.ErrNotFound):
		code = connect.CodeNotFound
	case errors.Is(err, plugin.ErrInvalidArgument):
		code = connect.CodeInvalidArgument
	case errors.Is(err, plugin.ErrFailedPrecondition):
		code = connect.CodeFailedPrecondition
	case errors.Is(err, plugin.ErrClosed):
		code = connect.CodeUnavailable
	case errors.Is(err, context.Canceled):
		code = connect.CodeCanceled
	case errors.Is(err, context.DeadlineExceeded):
		code = connect.CodeDeadlineExceeded
	}
	return connect.NewError(code, err)
}
