package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

// GetWorktreeDetail returns a worktree's files and log against its base.
func (h *Repo) GetWorktreeDetail(ctx context.Context, req *connect.Request[v1.GetWorktreeDetailRequest]) (*connect.Response[v1.GetWorktreeDetailResponse], error) {
	d, err := h.store.WorktreeDetail(ctx, req.Msg.GetRepoId(), req.Msg.GetPath())
	if err != nil {
		return nil, repoError(err)
	}
	return connect.NewResponse(&v1.GetWorktreeDetailResponse{Detail: worktreeDetailToProto(d)}), nil
}

func worktreeDetailToProto(d repo.WorktreeDetail) *v1.WorktreeDetail {
	p := &v1.WorktreeDetail{
		RepoId: d.RepoID, Path: d.Path, BaseRef: d.BaseRef, MergeBase: d.MergeBase, Head: d.Head,
		Files:          make([]*v1.FileChange, len(d.Files)),
		FilesTruncated: d.FilesTruncated,
		Log:            make([]*v1.LogEntry, len(d.Log)),
		LogTotal:       int32(d.LogTotal),
		ComputedAt:     timestamp(d.ComputedAt),
		Error:          d.Error,
	}
	for i, f := range d.Files {
		p.Files[i] = &v1.FileChange{
			Path: f.Path, OldPath: f.OldPath, Status: f.Status,
			Added: int32(f.Added), Deleted: int32(f.Deleted),
			Binary: f.Binary, Uncommitted: f.Uncommitted, IsDir: f.IsDir,
		}
	}
	for i, e := range d.Log {
		p.Log[i] = &v1.LogEntry{
			Sha: e.SHA, ShortSha: e.ShortSHA, Subject: e.Subject,
			AuthorName: e.AuthorName, AuthorEmail: e.AuthorEmail, AuthoredAt: timestamp(e.AuthoredAt),
		}
	}
	return p
}

// worktreeDetailEvent maps repo.WorktreeDetailUpdated (see eventToProto).
func worktreeDetailEvent(e repo.WorktreeDetailUpdated) *v1.RepoEvent {
	return &v1.RepoEvent{Event: &v1.RepoEvent_WorktreeDetailUpdated{WorktreeDetailUpdated: &v1.WorktreeDetailRef{
		RepoId: e.RepoID, Path: e.Path, ComputedAt: timestamp(e.ComputedAt),
	}}}
}
