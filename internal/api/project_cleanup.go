package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// WithCleanupHold sets what CleanupWorktrees and RemoveWorktree (without force) ask,
// besides git, before removing a worktree: why a thread on it, a running terminal or a workspace keeps it, or "". The
// daemon joins those stores' snapshots there; nil holds nothing.
func (h *Project) WithCleanupHold(hold func(project.Worktree) string) *Project {
	h.cleanupHold = hold
	return h
}

// CleanupWorktrees removes the project's merged, clean, unheld worktrees
// (project.Cleanup), or with dry_run lists them.
func (h *Project) CleanupWorktrees(ctx context.Context, req *connect.Request[v1.CleanupWorktreesRequest]) (*connect.Response[v1.CleanupWorktreesResponse], error) {
	r, err := workspace.ResolveProject(h.store.Snapshot(), req.Msg.GetProject())
	if err != nil {
		return nil, workspaceError(err)
	}
	res, err := project.Cleanup(ctx, h.store, project.CleanupOptions{
		ProjectID: r.ID, Path: req.Msg.GetPath(), DryRun: req.Msg.GetDryRun(), Force: req.Msg.GetForce(), Hold: h.cleanupHold,
	})
	if err != nil {
		return nil, projectError(err)
	}
	out := &v1.CleanupWorktreesResponse{ProjectId: res.ProjectID}
	for _, w := range res.Removed {
		out.Removed = append(out.Removed, &v1.RemovedWorktree{Worktree: worktreeToProto(w.Worktree), Reason: w.Reason, Uncommitted: w.Uncommitted})
	}
	for _, s := range res.Skipped {
		out.Skipped = append(out.Skipped, &v1.SkippedWorktree{Worktree: worktreeToProto(s.Worktree), Reason: s.Reason, Uncommitted: s.Uncommitted})
	}
	return connect.NewResponse(out), nil
}
