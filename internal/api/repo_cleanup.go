package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// WithCleanupHold sets what CleanupWorktrees asks, besides git, before removing a
// worktree: why a thread on it, a running terminal or a workspace keeps it, or "". The
// daemon joins those stores' snapshots there; nil holds nothing.
func (h *Repo) WithCleanupHold(hold func(repo.Worktree) string) *Repo {
	h.cleanupHold = hold
	return h
}

// CleanupWorktrees removes the repository's merged, clean, unheld worktrees
// (repo.Cleanup), or with dry_run lists them.
func (h *Repo) CleanupWorktrees(ctx context.Context, req *connect.Request[v1.CleanupWorktreesRequest]) (*connect.Response[v1.CleanupWorktreesResponse], error) {
	r, err := workspace.ResolveRepo(h.store.Snapshot(), req.Msg.GetRepo())
	if err != nil {
		return nil, workspaceError(err)
	}
	res, err := repo.Cleanup(ctx, h.store, repo.CleanupOptions{
		RepoID: r.ID, Path: req.Msg.GetPath(), DryRun: req.Msg.GetDryRun(), Hold: h.cleanupHold,
	})
	if err != nil {
		return nil, repoError(err)
	}
	out := &v1.CleanupWorktreesResponse{RepoId: res.RepoID}
	for _, w := range res.Removed {
		out.Removed = append(out.Removed, worktreeToProto(w))
	}
	for _, s := range res.Skipped {
		out.Skipped = append(out.Skipped, &v1.SkippedWorktree{Worktree: worktreeToProto(s.Worktree), Reason: s.Reason})
	}
	return connect.NewResponse(out), nil
}
