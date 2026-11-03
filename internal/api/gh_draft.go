package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// GhService's draft and auto-merge writes: SetPullRequestDraft and
// SetPullRequestAutoMerge. Thin: the gh store checks the state, sends the mutation, and
// invalidates the detail (docs/notes/pr-daemon-actions.md).

// SetPullRequestDraft marks a pull request ready for review or converts it to a draft.
func (h *Gh) SetPullRequestDraft(ctx context.Context, req *connect.Request[v1.SetPullRequestDraftRequest]) (*connect.Response[v1.SetPullRequestDraftResponse], error) {
	r, err := h.store.SetPullRequestDraft(ctx, req.Msg.GetRepoSlug(), int(req.Msg.GetNumber()), req.Msg.GetDraft())
	if err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.SetPullRequestDraftResponse{Draft: r.Draft, Message: r.Message}), nil
}

// SetPullRequestAutoMerge enables or disables GitHub's auto-merge.
func (h *Gh) SetPullRequestAutoMerge(ctx context.Context, req *connect.Request[v1.SetPullRequestAutoMergeRequest]) (*connect.Response[v1.SetPullRequestAutoMergeResponse], error) {
	c := gh.AutoMergeChange{Enabled: req.Msg.GetEnabled()}
	if c.Enabled {
		method, ok := mergeMethods[req.Msg.GetMethod()]
		if !ok {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("method is required to enable auto-merge: merge, squash, or rebase"))
		}
		c.Method, c.ExpectedHeadSHA = method, req.Msg.GetExpectedHeadSha()
	}
	r, err := h.store.SetPullRequestAutoMerge(ctx, req.Msg.GetRepoSlug(), int(req.Msg.GetNumber()), c)
	if err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.SetPullRequestAutoMergeResponse{
		Enabled: r.Enabled, Method: mergeMethodToProto(r.Method), Message: r.Message,
	}), nil
}

// mergeMethodToProto maps a merge method; "" is UNSPECIFIED.
func mergeMethodToProto(m gh.MergeMethod) v1.PullRequestMergeMethod {
	return enumOf[v1.PullRequestMergeMethod](v1.PullRequestMergeMethod_value, "PULL_REQUEST_MERGE_METHOD_", string(m))
}
