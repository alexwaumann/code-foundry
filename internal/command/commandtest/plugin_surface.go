package commandtest

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// PluginSurface is a fake command.PluginSurfaceBackend. Every call is recorded; Err,
// when set, is returned by every call.
type PluginSurface struct {
	Calls
	Err error
	// Got is what GetSurface returns.
	Got *v1.GetSurfaceResponse
}

var _ command.PluginSurfaceBackend = (*PluginSurface)(nil)

// GetSurface returns Got.
func (f *PluginSurface) GetSurface(_ context.Context, r *connect.Request[v1.GetSurfaceRequest]) (*connect.Response[v1.GetSurfaceResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	return connect.NewResponse(f.Got), nil
}

// Act answers with the request's version.
func (f *PluginSurface) Act(_ context.Context, r *connect.Request[v1.SurfaceActRequest]) (*connect.Response[v1.SurfaceActResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	return connect.NewResponse(&v1.SurfaceActResponse{Version: r.Msg.GetVersion()}), nil
}

// PullRequestChecks is a fake command.PullRequestChecksBackend answering Res.
type PullRequestChecks struct {
	Calls
	Err error
	Res *v1.GetPullRequestResponse
}

var _ command.PullRequestChecksBackend = (*PullRequestChecks)(nil)

// GetPullRequest returns Res.
func (f *PullRequestChecks) GetPullRequest(_ context.Context, r *connect.Request[v1.GetPullRequestRequest]) (*connect.Response[v1.GetPullRequestResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	return connect.NewResponse(f.Res), nil
}
