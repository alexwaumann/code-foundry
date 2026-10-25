package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// SetWorkspace sets or clears a thread's workspace reference. The store resolves the
// workspace and validates (docs/notes/workspaces-v2-3-composer.md).
func (h *Thread) SetWorkspace(ctx context.Context, req *connect.Request[v1.SetThreadWorkspaceRequest]) (*connect.Response[v1.SetThreadWorkspaceResponse], error) {
	s, err := h.store.SetWorkspace(ctx, req.Msg.GetId(), req.Msg.GetWorkspace())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.SetThreadWorkspaceResponse{Thread: threadToProto(s)}), nil
}
