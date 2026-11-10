package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// LinkPullRequest links a pull request to a thread by hand (docs/notes/pr-daemon-actions.md).
// The store republishes the thread when the link is new.
func (h *Thread) LinkPullRequest(ctx context.Context, req *connect.Request[v1.LinkThreadPullRequestRequest]) (*connect.Response[v1.LinkThreadPullRequestResponse], error) {
	s, l, linked, err := h.store.LinkPullRequest(ctx, req.Msg.GetId(), req.Msg.GetPullRequest())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.LinkThreadPullRequestResponse{Thread: threadToProto(s), Linked: linked, Link: linkedPullRequestToProto(l)}), nil
}

func linkedPullRequestToProto(l thread.LinkedPullRequest) *v1.LinkedPullRequest {
	lp := &v1.LinkedPullRequest{Slug: l.Slug, Number: int32(l.Number), Url: l.URL}
	lp.LinkedAt = timestamp(l.LinkedAt)
	return lp
}
