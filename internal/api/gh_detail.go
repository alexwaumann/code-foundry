package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Placeholders until the gh store implements the pull request detail panel.

var errNotYet = errors.New("not implemented yet")

// GetPullRequestDetail is not implemented yet.
func (h *Gh) GetPullRequestDetail(context.Context, *connect.Request[v1.GetPullRequestDetailRequest]) (*connect.Response[v1.GetPullRequestDetailResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errNotYet)
}

// ListReviewerCandidates is not implemented yet.
func (h *Gh) ListReviewerCandidates(context.Context, *connect.Request[v1.ListReviewerCandidatesRequest]) (*connect.Response[v1.ListReviewerCandidatesResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errNotYet)
}

// SetReviewRequest is not implemented yet.
func (h *Gh) SetReviewRequest(context.Context, *connect.Request[v1.SetReviewRequestRequest]) (*connect.Response[v1.SetReviewRequestResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errNotYet)
}

// RevertPullRequest is not implemented yet.
func (h *Gh) RevertPullRequest(context.Context, *connect.Request[v1.RevertPullRequestRequest]) (*connect.Response[v1.RevertPullRequestResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errNotYet)
}
