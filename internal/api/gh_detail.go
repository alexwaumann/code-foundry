package api

import (
	"context"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// GhService's pull request detail panel: GetPullRequestDetail, ListReviewerCandidates,
// SetReviewRequest, RevertPullRequest. Thin: the gh store fetches, caches, and talks to
// GitHub (docs/notes/gh-pr-detail.md).

// GetPullRequestDetail returns the detail panel's data for one pull request.
func (h *Gh) GetPullRequestDetail(ctx context.Context, req *connect.Request[v1.GetPullRequestDetailRequest]) (*connect.Response[v1.GetPullRequestDetailResponse], error) {
	d, err := h.store.FullPullRequest(ctx, req.Msg.GetRepoSlug(), int(req.Msg.GetNumber()), req.Msg.GetRefresh())
	if err != nil {
		return nil, ghError(err)
	}
	slug, _ := gh.NormalizeSlug(req.Msg.GetRepoSlug())
	return connect.NewResponse(&v1.GetPullRequestDetailResponse{Detail: fullPullRequestToProto(slug, &d)}), nil
}

// ListReviewerCandidates returns who can be asked to review.
func (h *Gh) ListReviewerCandidates(ctx context.Context, req *connect.Request[v1.ListReviewerCandidatesRequest]) (*connect.Response[v1.ListReviewerCandidatesResponse], error) {
	c, err := h.store.ReviewerCandidates(ctx, req.Msg.GetRepoSlug(), int(req.Msg.GetNumber()))
	if err != nil {
		return nil, ghError(err)
	}
	out := &v1.ListReviewerCandidatesResponse{Truncated: c.Truncated, Candidates: make([]*v1.ReviewerCandidate, 0, len(c.Candidates))}
	for _, x := range c.Candidates {
		out.Candidates = append(out.Candidates, &v1.ReviewerCandidate{
			Id:          x.ID,
			Kind:        enumOf[v1.ReviewerKind](v1.ReviewerKind_value, "REVIEWER_KIND_", string(x.Kind)),
			Login:       x.Login,
			Name:        x.Name,
			AvatarUrl:   x.AvatarURL,
			IsRequested: x.Requested,
		})
	}
	return connect.NewResponse(out), nil
}

// SetReviewRequest requests or withdraws a review.
func (h *Gh) SetReviewRequest(ctx context.Context, req *connect.Request[v1.SetReviewRequestRequest]) (*connect.Response[v1.SetReviewRequestResponse], error) {
	kind := gh.ReviewerUser
	if req.Msg.GetKind() == v1.ReviewerKind_REVIEWER_KIND_TEAM {
		kind = gh.ReviewerTeam
	}
	requested, err := h.store.SetReviewRequest(ctx, req.Msg.GetRepoSlug(), int(req.Msg.GetNumber()),
		gh.ReviewRequest{Login: req.Msg.GetLogin(), Kind: kind, Requested: req.Msg.GetRequested()})
	if err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.SetReviewRequestResponse{Requested: requested}), nil
}

// RevertPullRequest opens a revert of a merged pull request.
func (h *Gh) RevertPullRequest(ctx context.Context, req *connect.Request[v1.RevertPullRequestRequest]) (*connect.Response[v1.RevertPullRequestResponse], error) {
	r, err := h.store.RevertPullRequest(ctx, req.Msg.GetRepoSlug(), int(req.Msg.GetNumber()))
	if err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.RevertPullRequestResponse{Number: int32(r.Number), Url: r.URL}), nil
}

// ghDetailEvent maps the bus event; shared by GhService.Watch and EventService.
func ghDetailEvent(e gh.PullRequestDetailUpdated) *v1.GhEvent {
	return &v1.GhEvent{Event: &v1.GhEvent_PullRequestDetailUpdated_{PullRequestDetailUpdated: &v1.GhEvent_PullRequestDetailUpdated{
		RepoSlug: e.Slug, Number: int32(e.Number),
	}}}
}

func reviewStateOf(s string) v1.PullRequestReviewState {
	return enumOf[v1.PullRequestReviewState](v1.PullRequestReviewState_value, "PULL_REQUEST_REVIEW_STATE_", s)
}

func fullPullRequestToProto(slug string, d *gh.FullPullRequest) *v1.PullRequestDetail {
	out := &v1.PullRequestDetail{
		PullRequest:            pullRequestToProto(slug, &d.PullRequest),
		Body:                   d.Body,
		CommitCount:            int32(d.CommitCount),
		CommentsTruncated:      d.CommentsTruncated,
		ReviewThreadsTruncated: d.ThreadsTruncated,
		Checks:                 checkRunsToProto(d.Checks),
		MergeCommitSha:         d.MergeCommitSHA,
		MergedBy:               d.MergedBy,
		ClosedAt:               timestamp(d.ClosedAt),
		NodeId:                 d.PullRequest.ID,
		ViewerCanUpdate:        d.ViewerCanUpdate(),
		ViewerPermission:       strings.ToLower(d.ViewerPermission),
		FetchedAt:              timestamp(d.FetchedAt),
		LastError:              d.LastError,
	}
	for _, l := range d.Labels {
		out.Labels = append(out.Labels, &v1.PullRequestLabel{Name: l.Name, Color: l.Color})
	}
	for _, r := range d.Reviewers {
		out.Reviewers = append(out.Reviewers, &v1.PullRequestReviewer{
			Login: r.Login, IsTeam: r.Team, IsBot: r.Bot, AvatarUrl: r.AvatarURL, State: reviewStateOf(r.State),
			SubmittedAt: timestamp(r.SubmittedAt), Requested: r.Requested, Stale: r.Stale,
		})
	}
	for _, c := range d.Commits {
		out.Commits = append(out.Commits, &v1.PullRequestCommit{
			Sha: c.SHA, Headline: c.Headline, AuthorLogin: c.AuthorLogin, AuthorName: c.AuthorName, CommittedAt: timestamp(c.CommittedAt),
		})
	}
	for i := range d.Comments {
		out.Comments = append(out.Comments, commentToProto(&d.Comments[i]))
	}
	for _, t := range d.Threads {
		pt := &v1.PullRequestReviewThread{
			Id: t.ID, Path: t.Path, Line: int32(t.Line), Side: enumOf[v1.DiffSide](v1.DiffSide_value, "DIFF_SIDE_", t.Side),
			IsResolved: t.Resolved, IsOutdated: t.Outdated, CommentsTruncated: t.CommentsTruncated,
		}
		for i := range t.Comments {
			pt.Comments = append(pt.Comments, commentToProto(&t.Comments[i]))
		}
		out.ReviewThreads = append(out.ReviewThreads, pt)
	}
	return out
}

func commentToProto(c *gh.Comment) *v1.PullRequestComment {
	return &v1.PullRequestComment{
		Id:              c.ID,
		Kind:            enumOf[v1.PullRequestCommentKind](v1.PullRequestCommentKind_value, "PULL_REQUEST_COMMENT_KIND_", string(c.Kind)),
		Author:          c.Author,
		AuthorIsBot:     c.AuthorBot,
		AuthorAvatarUrl: c.AuthorAvatar,
		Body:            c.Body,
		CreatedAt:       timestamp(c.CreatedAt),
		Url:             c.URL,
		Path:            c.Path,
		ReviewState:     reviewStateOf(c.ReviewState),
	}
}
