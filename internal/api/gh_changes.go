package api

import (
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/gh"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// ghChangedBuffer is the PullRequestChanged subscriptions' buffer: one poll publishes
// one per changed pull request, back to back, so a burst (a laptop waking to a day of
// changes) must fit, or the stream resyncs the gh source and the changes are lost.
const ghChangedBuffer = 512

// ghPullRequestChangedEvent maps gh.PullRequestChanged; shared by GhService.Watch and
// EventService (and so the CLI's events verb and plugin feeds).
func ghPullRequestChangedEvent(e gh.PullRequestChanged) *v1.GhEvent {
	out := &v1.GhEvent_PullRequestChanged{
		RepoSlug: e.Slug, Number: int32(e.Number), Url: e.URL, HeadRef: e.HeadRef,
		PullRequest: pullRequestToProto(e.Slug, &e.PullRequest),
	}
	for _, c := range e.Changes {
		out.Changes = append(out.Changes, pullRequestChangeToProto(c))
	}
	return &v1.GhEvent{Event: &v1.GhEvent_PullRequestChanged_{PullRequestChanged: out}}
}

// pullRequestChangeToProto sets the kind and only the values its kind names.
func pullRequestChangeToProto(c gh.Change) *v1.PullRequestChange {
	out := &v1.PullRequestChange{
		Kind: enumOf[v1.PullRequestChangeKind](v1.PullRequestChangeKind_value, "PULL_REQUEST_CHANGE_KIND_", strings.ToUpper(string(c.Kind))),
	}
	state := func(s gh.PullRequestState) v1.PullRequestState {
		return enumOf[v1.PullRequestState](v1.PullRequestState_value, "PULL_REQUEST_STATE_", string(s))
	}
	decision := func(d gh.ReviewDecision) v1.ReviewDecision {
		return enumOf[v1.ReviewDecision](v1.ReviewDecision_value, "REVIEW_DECISION_", string(d))
	}
	switch c.Kind {
	case gh.ChangeMerged, gh.ChangeClosed, gh.ChangeReopened:
		out.OldState, out.NewState = state(c.OldState), state(c.NewState)
	case gh.ChangeHeadPushed:
		out.OldHeadSha, out.NewHeadSha = c.OldHeadSHA, c.NewHeadSHA
	case gh.ChangeChecks:
		out.OldChecks, out.NewChecks = rollupToProto(c.OldChecks), rollupToProto(c.NewChecks)
	case gh.ChangeReviewDecision:
		out.OldReviewDecision, out.NewReviewDecision = decision(c.OldReviewDecision), decision(c.NewReviewDecision)
	case gh.ChangeReviews, gh.ChangeComments:
		out.OldCount, out.NewCount = int32(c.OldCount), int32(c.NewCount)
	case gh.ChangeReviewRequested:
		out.Requested, out.ViewerRequested = c.Requested, c.Viewer
	case gh.ChangeDraft:
		out.OldDraft, out.NewDraft = c.OldDraft, c.NewDraft
	case gh.ChangeTitle:
		out.OldTitle, out.NewTitle = c.OldTitle, c.NewTitle
	}
	return out
}
