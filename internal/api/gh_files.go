package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// GetPullRequestDiff returns a pull request's unified diff.
func (h *Gh) GetPullRequestDiff(ctx context.Context, req *connect.Request[v1.GetPullRequestDiffRequest]) (*connect.Response[v1.GetPullRequestDiffResponse], error) {
	d, err := h.store.PullRequestDiff(ctx, req.Msg.GetRepoSlug(), int(req.Msg.GetNumber()), req.Msg.GetRefresh())
	if err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.GetPullRequestDiffResponse{
		Diff: d.Diff, HeadSha: d.HeadSHA, BaseSha: d.BaseSHA, Truncated: d.Truncated, FetchedAt: timestamp(d.FetchedAt),
	}), nil
}

// GetPullRequestFile returns one file of a repository at a commit.
func (h *Gh) GetPullRequestFile(ctx context.Context, req *connect.Request[v1.GetPullRequestFileRequest]) (*connect.Response[v1.GetPullRequestFileResponse], error) {
	f, err := h.store.PullRequestFile(ctx, req.Msg.GetRepoSlug(), req.Msg.GetRef(), req.Msg.GetPath())
	if err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.GetPullRequestFileResponse{
		Contents: f.Contents, Truncated: f.Truncated, Binary: f.Binary, NotFound: f.NotFound,
	}), nil
}
