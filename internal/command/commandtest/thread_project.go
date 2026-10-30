package commandtest

import (
	"context"
	"slices"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// AddProject returns Current (default: a CONNECTED thread) with the requested id, the
// project appended to project_ids and workspace_id cleared, as the daemon leaves the
// workspace. No validation.
func (s *Thread) AddProject(_ context.Context, r *connect.Request[v1.AddThreadProjectRequest]) (*connect.Response[v1.AddThreadProjectResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := s.current(r.Msg.GetId())
	cur.ProjectIds = append(cur.ProjectIds, r.Msg.GetProject())
	cur.WorkspaceId = ""
	return connect.NewResponse(&v1.AddThreadProjectResponse{Thread: cur}), nil
}

// RemoveProject returns Current with the project dropped from project_ids and
// workspace_id cleared. No validation.
func (s *Thread) RemoveProject(_ context.Context, r *connect.Request[v1.RemoveThreadProjectRequest]) (*connect.Response[v1.RemoveThreadProjectResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := s.current(r.Msg.GetId())
	cur.ProjectIds = slices.DeleteFunc(cur.ProjectIds, func(id string) bool { return id == r.Msg.GetProject() })
	cur.WorkspaceId = ""
	return connect.NewResponse(&v1.RemoveThreadProjectResponse{Thread: cur}), nil
}
