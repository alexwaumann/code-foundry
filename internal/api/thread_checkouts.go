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
		WorkspaceDirMissing: tc.WorkspaceDirMissing, WorkspaceStrays: tc.WorkspaceStrays,
		Checkouts: make([]*v1.ThreadCheckout, len(tc.Checkouts)),
	}
	for i, c := range tc.Checkouts {
		res.Checkouts[i] = &v1.ThreadCheckout{
			ProjectId: c.ProjectID, ProjectName: c.ProjectName, Path: c.Path, Branch: c.Branch, Primary: c.Primary,
			Missing: c.Missing, Current: i == tc.Current, Instructions: c.Instructions, Git: c.Git, WorktreeMode: c.WorktreeMode,
			Head: c.Head, Detached: c.Detached, IsMain: c.Main, CreatedBranch: c.CreatedBranch, Moved: c.Moved,
		}
		if c.Listed && c.Git {
			res.Checkouts[i].Status = gitStatusToProto(c.Status)
		}
	}
	return res
}

// CheckPlacement reports where a new thread would go (thread.Manager.CheckPlacement).
func (h *Thread) CheckPlacement(ctx context.Context, req *connect.Request[v1.CheckPlacementRequest]) (*connect.Response[v1.CheckPlacementResponse], error) {
	rep, err := h.store.CheckPlacement(ctx, thread.PlacementCheck{
		ProjectIDs: req.Msg.GetProjectIds(), Branch: req.Msg.GetBranch(), CheckoutMode: req.Msg.GetCheckoutMode(),
	})
	if err != nil {
		return nil, threadError(err)
	}
	out := &v1.CheckPlacementResponse{Branch: rep.Branch, BranchNamedAtCreate: rep.BranchNamedAtCreate}
	for _, m := range rep.Members {
		out.Members = append(out.Members, &v1.MemberPlacement{
			ProjectId: m.ProjectID, ProjectName: m.ProjectName, Outcome: placementOutcomes[m.Outcome],
			Path: m.Path, Branch: m.Branch, Message: m.Message,
		})
	}
	return connect.NewResponse(out), nil
}

// placementOutcomes maps thread.PlacementOutcome to the proto enum.
var placementOutcomes = map[thread.PlacementOutcome]v1.PlacementOutcome{
	thread.PlacementNew:     v1.PlacementOutcome_PLACEMENT_OUTCOME_NEW,
	thread.PlacementShare:   v1.PlacementOutcome_PLACEMENT_OUTCOME_SHARE,
	thread.PlacementFolder:  v1.PlacementOutcome_PLACEMENT_OUTCOME_FOLDER,
	thread.PlacementRefused: v1.PlacementOutcome_PLACEMENT_OUTCOME_REFUSED,
}

// checkoutPathsToProto is Thread.checkout_paths: one per member, in project id order,
// "" for a member with none recorded.
func checkoutPathsToProto(s thread.Thread) []*v1.ThreadCheckoutPath {
	ids := s.Projects()
	if len(ids) == 0 {
		return nil
	}
	out := make([]*v1.ThreadCheckoutPath, len(ids))
	for i, id := range ids {
		p, _ := s.CheckoutPath(id)
		out[i] = &v1.ThreadCheckoutPath{ProjectId: id, Path: p}
	}
	return out
}
