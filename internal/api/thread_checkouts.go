package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Checkouts lists a thread's checkouts (docs/notes/workspaces-v2-1-threads.md).
func (h *Thread) Checkouts(ctx context.Context, req *connect.Request[v1.ThreadCheckoutsRequest]) (*connect.Response[v1.ThreadCheckoutsResponse], error) {
	tc, err := h.store.Checkouts(ctx, thread.CheckoutsRef{ID: req.Msg.GetId(), Cwd: req.Msg.GetCwd()})
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(checkoutsToProto(tc)), nil
}

func checkoutsToProto(tc thread.ThreadCheckouts) *v1.ThreadCheckoutsResponse {
	res := &v1.ThreadCheckoutsResponse{
		Thread: threadToProto(tc.Thread), WorkspaceId: tc.WorkspaceID, WorkspaceName: tc.WorkspaceName, WorkspaceDir: tc.WorkspaceDir,
		Checkouts: make([]*v1.ThreadCheckout, len(tc.Checkouts)),
	}
	for i, c := range tc.Checkouts {
		res.Checkouts[i] = &v1.ThreadCheckout{
			ProjectId: c.ProjectID, ProjectName: c.ProjectName, Path: c.Path, Branch: c.Branch, Primary: c.Primary,
			Missing: c.Missing, Current: i == tc.Current, Instructions: c.Instructions, Git: c.Git, Derived: c.Derived,
		}
	}
	return res
}
