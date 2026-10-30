package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// AddProject adds a project to a thread's set (docs/notes/thread-project-set.md).
func (h *Thread) AddProject(ctx context.Context, req *connect.Request[v1.AddThreadProjectRequest]) (*connect.Response[v1.AddThreadProjectResponse], error) {
	s, err := h.store.AddProject(ctx, req.Msg.GetId(), req.Msg.GetProject())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.AddThreadProjectResponse{Thread: threadToProto(s)}), nil
}

// RemoveProject drops a member that is not the cwd's from a thread's set.
func (h *Thread) RemoveProject(ctx context.Context, req *connect.Request[v1.RemoveThreadProjectRequest]) (*connect.Response[v1.RemoveThreadProjectResponse], error) {
	s, err := h.store.RemoveProject(ctx, req.Msg.GetId(), req.Msg.GetProject())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.RemoveThreadProjectResponse{Thread: threadToProto(s)}), nil
}
