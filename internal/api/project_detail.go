package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// GetWorktreeDetail returns a worktree's files against its base.
func (h *Project) GetWorktreeDetail(ctx context.Context, req *connect.Request[v1.GetWorktreeDetailRequest]) (*connect.Response[v1.GetWorktreeDetailResponse], error) {
	d, err := h.store.WorktreeDetail(ctx, req.Msg.GetProjectId(), req.Msg.GetPath())
	if err != nil {
		return nil, projectError(err)
	}
	return connect.NewResponse(&v1.GetWorktreeDetailResponse{Detail: worktreeDetailToProto(d)}), nil
}

func worktreeDetailToProto(d project.WorktreeDetail) *v1.WorktreeDetail {
	p := &v1.WorktreeDetail{
		ProjectId: d.ProjectID, Path: d.Path, BaseRef: d.BaseRef, MergeBase: d.MergeBase, Head: d.Head,
		Files:          make([]*v1.FileChange, len(d.Files)),
		FilesTruncated: d.FilesTruncated,
		ComputedAt:     timestamp(d.ComputedAt),
		Error:          d.Error,
	}
	for i, f := range d.Files {
		p.Files[i] = &v1.FileChange{
			Path: f.Path, OldPath: f.OldPath, Status: f.Status,
			Added: int32(f.Added), Deleted: int32(f.Deleted),
			Binary: f.Binary, Uncommitted: f.Uncommitted,
		}
	}
	return p
}

// worktreeDetailEvent maps project.WorktreeDetailUpdated (see eventToProto).
func worktreeDetailEvent(e project.WorktreeDetailUpdated) *v1.ProjectEvent {
	return &v1.ProjectEvent{Event: &v1.ProjectEvent_WorktreeDetailUpdated{WorktreeDetailUpdated: &v1.WorktreeDetailRef{
		ProjectId: e.ProjectID, Path: e.Path, ComputedAt: timestamp(e.ComputedAt),
	}}}
}
