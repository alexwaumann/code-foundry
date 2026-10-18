package api

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// diffScopes maps the proto scope; UNSPECIFIED is WORKING.
var diffScopes = map[v1.DiffScope]project.DiffScope{
	v1.DiffScope_DIFF_SCOPE_UNSPECIFIED: project.DiffWorking,
	v1.DiffScope_DIFF_SCOPE_WORKING:     project.DiffWorking,
	v1.DiffScope_DIFF_SCOPE_BRANCH:      project.DiffBranch,
}

// GetWorktreeFileDiff returns both sides of one worktree file against its base.
func (h *Project) GetWorktreeFileDiff(ctx context.Context, req *connect.Request[v1.GetWorktreeFileDiffRequest]) (*connect.Response[v1.GetWorktreeFileDiffResponse], error) {
	m := req.Msg
	scope, ok := diffScopes[m.GetScope()]
	switch {
	case !ok:
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unknown scope %v", m.GetScope()))
	case m.GetProjectId() == "" || m.GetPath() == "":
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("project_id and path are required"))
	}
	d, err := h.store.WorktreeFileDiff(ctx, project.FileDiffRequest{
		ProjectID: m.GetProjectId(), Path: m.GetPath(), File: m.GetFile(), OldPath: m.GetOldPath(), Scope: scope,
	})
	if err != nil {
		return nil, projectError(err)
	}
	return connect.NewResponse(&v1.GetWorktreeFileDiffResponse{
		Old: fileVersionToProto(d.Old), New: fileVersionToProto(d.New),
		BaseRef: d.BaseRef, MergeBase: d.MergeBase, Head: d.Head, Status: d.Status, Error: d.Error,
	}), nil
}

func fileVersionToProto(v project.FileVersion) *v1.FileVersion {
	return &v1.FileVersion{Present: v.Present, Contents: v.Contents, Truncated: v.Truncated, Binary: v.Binary}
}
