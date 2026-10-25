package commandtest

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// SetWorkspace returns Current (default: a CONNECTED thread) with the requested id and
// workspace_id set to the request's workspace as given. No validation: the daemon
// resolves names and refuses a thread that runs in its workspace's folder.
func (s *Thread) SetWorkspace(_ context.Context, r *connect.Request[v1.SetThreadWorkspaceRequest]) (*connect.Response[v1.SetThreadWorkspaceResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := s.current(r.Msg.GetId())
	cur.WorkspaceId = r.Msg.GetWorkspace()
	return connect.NewResponse(&v1.SetThreadWorkspaceResponse{Thread: cur}), nil
}
