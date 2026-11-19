package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// SetPullRequestClosed closes or reopens a pull request. Thin: the gh store checks the
// state and the viewer's permission, sends the mutation, and invalidates the detail
// (docs/notes/pr-close-reopen.md).
func (h *Gh) SetPullRequestClosed(ctx context.Context, req *connect.Request[v1.SetPullRequestClosedRequest]) (*connect.Response[v1.SetPullRequestClosedResponse], error) {
	r, err := h.store.SetPullRequestClosed(ctx, req.Msg.GetRepoSlug(), int(req.Msg.GetNumber()), req.Msg.GetClosed())
	if err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.SetPullRequestClosedResponse{
		State:   enumOf[v1.PullRequestState](v1.PullRequestState_value, "PULL_REQUEST_STATE_", string(r.State)),
		Message: r.Message,
	}), nil
}
