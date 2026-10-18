package api

import (
	"context"
	"maps"
	"slices"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
)

// Environment returns the plugins' session environments as applied
// (internal/store/plugin/environment.go).
func (h *Plugin) Environment(_ context.Context, req *connect.Request[v1.PluginEnvironmentRequest]) (*connect.Response[v1.PluginEnvironmentResponse], error) {
	envs, err := h.store.Environments(req.Msg.GetName())
	if err != nil {
		return nil, pluginError(err)
	}
	out := &v1.PluginEnvironmentResponse{}
	for _, e := range envs {
		out.Environments = append(out.Environments, pluginEnvironmentToProto(e))
	}
	return connect.NewResponse(out), nil
}

func pluginEnvironmentToProto(e plugin.Environment) *v1.PluginEnvironment {
	p := &v1.PluginEnvironment{
		Plugin: e.Plugin, PathPrepend: e.PathPrepend, AddDirs: e.AddDirs, Projects: e.Projects,
		NoProject: e.NoProject, Issues: e.Issues,
	}
	for _, k := range slices.Sorted(maps.Keys(e.Env)) {
		p.Env = append(p.Env, &v1.PluginEnvVar{Key: k, Value: e.Env[k]})
	}
	if !e.UpdatedAt.IsZero() {
		p.UpdatedAt = timestamppb.New(e.UpdatedAt)
	}
	return p
}
