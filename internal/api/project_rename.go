package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Rename sets a project's display name (project.CheckName's rules).
func (h *Project) Rename(ctx context.Context, req *connect.Request[v1.RenameProjectRequest]) (*connect.Response[v1.RenameProjectResponse], error) {
	r, err := h.store.Rename(ctx, req.Msg.GetId(), req.Msg.GetName())
	if err != nil {
		return nil, projectError(err)
	}
	return connect.NewResponse(&v1.RenameProjectResponse{Project: projectToProto(r)}), nil
}
