package api

import (
	"context"
	"fmt"
	"path/filepath"

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

// WithCleanupAbandoned sets how CleanupWorktrees tells a worktree whose threads are all
// archived or removed (project.CleanupOptions.Abandoned), and what it tells of each
// worktree right before removing it (Removing); nil for either is nothing.
func (h *Project) WithCleanupAbandoned(abandoned func(project.Worktree) bool, removing func(context.Context, project.Worktree)) *Project {
	h.cleanupAbandoned, h.cleanupRemoving = abandoned, removing
	return h
}

// CleanupWorktrees removes the project's merged, clean, unheld worktrees
// (project.Cleanup), or with dry_run lists them. It reports only what it removed: with
// a path, a worktree it kept fails the call (FailedPrecondition, with why); a dry run
// with a path lists nothing for it instead (the real run fetches first and may differ).
func (h *Project) CleanupWorktrees(ctx context.Context, req *connect.Request[v1.CleanupWorktreesRequest]) (*connect.Response[v1.CleanupWorktreesResponse], error) {
	r, err := workspace.ResolveProject(h.store.Snapshot(), req.Msg.GetProject())
	if err != nil {
		return nil, workspaceError(err)
	}
	res, err := project.Cleanup(ctx, h.store, project.CleanupOptions{
		ProjectID: r.ID, Path: req.Msg.GetPath(), DryRun: req.Msg.GetDryRun(), Hold: h.cleanupHold,
		Abandoned: h.cleanupAbandoned, Removing: h.cleanupRemoving,
	})
	if err != nil {
		return nil, projectError(err)
	}
	if req.Msg.GetPath() != "" && !req.Msg.GetDryRun() && len(res.Removed) == 0 && len(res.Skipped) > 0 {
		s := res.Skipped[0]
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s was not removed: %s", cleanupLabel(s.Worktree), s.Reason))
	}
	out := &v1.CleanupWorktreesResponse{ProjectId: res.ProjectID}
	for _, w := range res.Removed {
		out.Removed = append(out.Removed, &v1.RemovedWorktree{Worktree: worktreeToProto(w.Worktree), Reason: w.Reason, Kind: cleanupKindToProto(w.Kind)})
	}
	return connect.NewResponse(out), nil
}

// cleanupLabel names a worktree in a cleanup error: its branch, else its directory.
func cleanupLabel(w project.Worktree) string {
	if w.Branch != "" {
		return w.Branch
	}
	return filepath.Base(w.Path)
}

func cleanupKindToProto(k project.CleanupKind) v1.CleanupKind {
	switch k {
	case project.KindMerged:
		return v1.CleanupKind_CLEANUP_KIND_MERGED
	case project.KindSquashMerged:
		return v1.CleanupKind_CLEANUP_KIND_SQUASH_MERGED
	case project.KindNoCommits:
		return v1.CleanupKind_CLEANUP_KIND_NO_COMMITS
	}
	return v1.CleanupKind_CLEANUP_KIND_UNSPECIFIED
}
