package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// SetIncludeIgnored replaces a project's include patterns (project.CleanIncludes' rules).
func (h *Project) SetIncludeIgnored(ctx context.Context, req *connect.Request[v1.SetIncludeIgnoredRequest]) (*connect.Response[v1.SetIncludeIgnoredResponse], error) {
	r, err := h.store.SetIncludeIgnored(ctx, req.Msg.GetId(), req.Msg.GetPatterns())
	if err != nil {
		return nil, projectError(err)
	}
	return connect.NewResponse(&v1.SetIncludeIgnoredResponse{Project: projectToProto(r)}), nil
}
