package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// DeleteBranch deletes a branch no worktree has checked out (project.branch.delete).
func (h *Project) DeleteBranch(ctx context.Context, req *connect.Request[v1.DeleteBranchRequest]) (*connect.Response[v1.DeleteBranchResponse], error) {
	m := req.Msg
	res, err := h.store.DeleteBranch(ctx, project.DeleteBranchOptions{
		ProjectID: m.GetProjectId(), Branch: m.GetBranch(), Force: m.GetForce(), Remote: m.GetRemote(),
	})
	if err != nil {
		return nil, projectError(err)
	}
	return connect.NewResponse(&v1.DeleteBranchResponse{LocalDeleted: res.Local, RemoteDeleted: res.Remote}), nil
}
