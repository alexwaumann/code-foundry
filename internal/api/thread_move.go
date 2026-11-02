package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Move takes a thread without a project into a project or a workspace
// (docs/notes/move-no-project-1-daemon.md).
func (h *Thread) Move(ctx context.Context, req *connect.Request[v1.MoveThreadRequest]) (*connect.Response[v1.MoveThreadResponse], error) {
	m := req.Msg
	o := thread.MoveOptions{ProjectID: m.GetProjectId(), WorktreePath: m.GetWorktreePath(), WorkspaceID: m.GetWorkspaceId(), CheckoutMode: m.GetCheckoutMode()}
	if nw := m.GetNewWorktree(); nw != nil {
		o.NewWorktree = &thread.NewWorktree{BaseRef: nw.GetBaseRef(), Branch: nw.GetBranch(), BaseFromOrigin: optionalBool(nw.BaseFromOrigin)}
	}
	var report thread.CreateReport
	o.Report = &report
	s, err := h.store.Move(ctx, m.GetId(), o)
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.MoveThreadResponse{
		Thread: threadToProto(s), MadeWorktree: report.MadeWorktree, MadeBranch: report.MadeBranch,
		ExistingWorktree: report.ExistingWorktree, SharedWith: report.SharedWith, Hints: h.store.CheckoutHints(s),
	}), nil
}

// moveToProto is Thread.pending_move; nil when no move is under way.
func moveToProto(t *thread.MoveTarget) *v1.ThreadMove {
	if t == nil {
		return nil
	}
	return &v1.ThreadMove{ProjectId: t.ProjectID, WorkspaceId: t.WorkspaceID, WorktreePath: t.Path, Branch: t.Branch}
}
