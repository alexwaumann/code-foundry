package commandtest

import (
	"context"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// PluginRegistry is a fake command.PluginRegistryBackend: Browse answers BrowseRes,
// Install InstallRes, Update UpdateRes, Uninstall UninstallRes. Every call is recorded;
// Err, when set, is returned by every call.
type PluginRegistry struct {
	Calls
	Err          error
	BrowseRes    *v1.BrowsePluginsResponse
	InstallRes   *v1.InstallPluginResponse
	UpdateRes    *v1.UpdatePluginsResponse
	UninstallRes *v1.UninstallPluginResponse
}

var _ command.PluginRegistryBackend = (*PluginRegistry)(nil)

func answer[T any](f *PluginRegistry, req proto.Message, res *T) (*connect.Response[T], error) {
	f.record(req)
	if f.Err != nil {
		return nil, f.Err
	}
	if res == nil {
		res = new(T)
	}
	return connect.NewResponse(res), nil
}

// Browse returns BrowseRes.
func (f *PluginRegistry) Browse(_ context.Context, r *connect.Request[v1.BrowsePluginsRequest]) (*connect.Response[v1.BrowsePluginsResponse], error) {
	return answer(f, r.Msg, f.BrowseRes)
}

// Install returns InstallRes.
func (f *PluginRegistry) Install(_ context.Context, r *connect.Request[v1.InstallPluginRequest]) (*connect.Response[v1.InstallPluginResponse], error) {
	return answer(f, r.Msg, f.InstallRes)
}

// Update returns UpdateRes.
func (f *PluginRegistry) Update(_ context.Context, r *connect.Request[v1.UpdatePluginsRequest]) (*connect.Response[v1.UpdatePluginsResponse], error) {
	return answer(f, r.Msg, f.UpdateRes)
}

// Uninstall returns UninstallRes.
func (f *PluginRegistry) Uninstall(_ context.Context, r *connect.Request[v1.UninstallPluginRequest]) (*connect.Response[v1.UninstallPluginResponse], error) {
	return answer(f, r.Msg, f.UninstallRes)
}
