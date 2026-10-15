package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// GhService's review writes: SubmitPullRequestReview and AddPullRequestComment. Thin:
// the gh store validates the body, sends the mutation, and invalidates the detail
// (docs/notes/pr-review-submit-1-daemon.md).

var reviewEvents = map[v1.PullRequestReviewEvent]gh.ReviewEvent{
	v1.PullRequestReviewEvent_PULL_REQUEST_REVIEW_EVENT_APPROVE:         gh.ReviewEventApprove,
	v1.PullRequestReviewEvent_PULL_REQUEST_REVIEW_EVENT_REQUEST_CHANGES: gh.ReviewEventRequestChanges,
	v1.PullRequestReviewEvent_PULL_REQUEST_REVIEW_EVENT_COMMENT:         gh.ReviewEventComment,
}

// SubmitPullRequestReview submits a review as the viewer.
func (h *Gh) SubmitPullRequestReview(ctx context.Context, req *connect.Request[v1.SubmitPullRequestReviewRequest]) (*connect.Response[v1.SubmitPullRequestReviewResponse], error) {
	event, ok := reviewEvents[req.Msg.GetEvent()]
	if !ok {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("event is required: approve, request changes, or comment"))
	}
	r, err := h.store.SubmitPullRequestReview(ctx, req.Msg.GetRepoSlug(), int(req.Msg.GetNumber()),
		gh.ReviewSubmission{Event: event, Body: req.Msg.GetBody()})
	if err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.SubmitPullRequestReviewResponse{
		Id: r.ID, Url: r.URL, State: reviewStateOf(r.State), Author: r.Author, SubmittedAt: timestamp(r.SubmittedAt),
	}), nil
}

// AddPullRequestComment posts a comment on a pull request's conversation.
func (h *Gh) AddPullRequestComment(ctx context.Context, req *connect.Request[v1.AddPullRequestCommentRequest]) (*connect.Response[v1.AddPullRequestCommentResponse], error) {
	c, err := h.store.AddPullRequestComment(ctx, req.Msg.GetRepoSlug(), int(req.Msg.GetNumber()), req.Msg.GetBody())
	if err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.AddPullRequestCommentResponse{Id: c.ID, Url: c.URL, CreatedAt: timestamp(c.CreatedAt)}), nil
}
