package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/gh/ghtest"
)

func newGhTest(t *testing.T) (*ghtest.Store, codefoundryv1connect.GhServiceClient) {
	t.Helper()
	store, client, _ := newGhTestBus(t)
	return store, client
}

// newGhTestBus is newGhTest with the bus, for EventService's gh source (ghEvents).
func newGhTestBus(t *testing.T) (*ghtest.Store, codefoundryv1connect.GhServiceClient, *bus.Bus) {
	t.Helper()
	b := bus.New()
	store := ghtest.New(b)
	route := NewGh(store).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return store, codefoundryv1connect.NewGhServiceClient(srv.Client(), srv.URL), b
}

// ghEvents is EventService's gh source; it returns once the stream is joined (its first
// snapshot event read), so nothing published after it is missed.
func ghEvents(t *testing.T, ctx context.Context, store *ghtest.Store, b *bus.Bus) *sourceStream[*v1.GhEvent] {
	t.Helper()
	s := watchSource(t, ctx, EventsDeps{Bus: b, Gh: store}, v1.EventSource_EVENT_SOURCE_GH, (*v1.Event).GetGh)
	if !s.Receive() {
		t.Fatalf("no snapshot: %v", s.Err())
	}
	return s
}

func TestGhReads(t *testing.T) {
	store, client := newGhTest(t)
	ctx := context.Background()
	at := time.Date(2026, 10, 8, 6, 0, 0, 0, time.UTC)

	// Empty store: unauthenticated-unknown viewer, empty untracked repo.
	v, err := client.GetViewer(ctx, connect.NewRequest(&v1.GetViewerRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if v.Msg.GetViewer() != nil || !v.Msg.GetAuthenticated() || v.Msg.GetFetchedAt() != nil {
		t.Errorf("empty viewer = %v", v.Msg)
	}

	store.SetViewer(gh.ViewerState{Viewer: &gh.Viewer{Login: "octocat", Name: "The Octocat"}, Authenticated: true, FetchedAt: at})
	v, err = client.GetViewer(ctx, connect.NewRequest(&v1.GetViewerRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if v.Msg.GetViewer().GetLogin() != "octocat" || !v.Msg.GetFetchedAt().AsTime().Equal(at) {
		t.Errorf("viewer = %v", v.Msg)
	}

	// Every pull request field maps (GetPullRequest; the dashboards share the mapping).
	store.SetPullRequest("ghostty-org/ghostty", gh.PullRequestDetail{
		PullRequest: gh.PullRequest{
			ID: "PR_1", Number: 14000, Title: "i18n", Author: "kgni", HeadRef: "i18n/da_DK", HeadSHA: "7b60f9b", BaseRef: "main",
			Draft: true, ReviewDecision: gh.ReviewRequired, Mergeable: gh.MergeableConflicting, MergeStateStatus: "DIRTY",
			IsCrossRepository: true, URL: "https://github.com/ghostty-org/ghostty/pull/14000", UpdatedAt: at,
			Checks: gh.CheckRollup{State: gh.RollupFailure, Total: 10, Passed: 6, Failed: 1, Pending: 2, Skipped: 1},
			Repo:   "ghostty-org/ghostty", State: gh.PullRequestOpen, Additions: 51, Deletions: 52, ChangedFiles: 1,
			Comments: 9, Reviews: 2, ReviewRequests: []string{"kim", "acme/core"}, Partial: true,
			LatestReviews: []gh.Review{{Author: "trag1c", State: "CHANGES_REQUESTED", SubmittedAt: at}, {Author: "x", State: "NEW_STATE"}},
		},
		FetchedAt: at,
	})
	full, err := client.GetPullRequest(ctx, connect.NewRequest(&v1.GetPullRequestRequest{RepoSlug: "ghostty-org/ghostty", Number: 14000}))
	if err != nil {
		t.Fatal(err)
	}
	pr := full.Msg.GetPullRequest()
	if pr.GetRepoSlug() != "ghostty-org/ghostty" || pr.GetNumber() != 14000 || !pr.GetDraft() ||
		pr.GetReviewDecision() != v1.ReviewDecision_REVIEW_DECISION_REVIEW_REQUIRED ||
		pr.GetMergeable() != v1.Mergeable_MERGEABLE_CONFLICTING ||
		pr.GetMergeStateStatus() != v1.MergeStateStatus_MERGE_STATE_STATUS_DIRTY ||
		pr.GetChecks().GetState() != v1.CheckRollupState_CHECK_ROLLUP_STATE_FAILURE ||
		pr.GetChecks().GetPending() != 2 || !pr.GetUpdatedAt().AsTime().Equal(at) ||
		pr.GetState() != v1.PullRequestState_PULL_REQUEST_STATE_OPEN || pr.GetAdditions() != 51 || pr.GetDeletions() != 52 ||
		pr.GetChangedFiles() != 1 || pr.GetCommentCount() != 9 || pr.GetReviewCount() != 2 || !pr.GetPartial() ||
		fmt.Sprint(pr.GetReviewRequests()) != "[kim acme/core]" || len(pr.GetLatestReviews()) != 2 ||
		pr.GetLatestReviews()[0].GetState() != v1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_CHANGES_REQUESTED ||
		pr.GetLatestReviews()[0].GetAuthor() != "trag1c" || !pr.GetLatestReviews()[0].GetSubmittedAt().AsTime().Equal(at) ||
		pr.GetLatestReviews()[1].GetState() != v1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_UNSPECIFIED {
		t.Errorf("pr = %v", pr)
	}

	store.SetPullRequest("ghostty-org/ghostty", gh.PullRequestDetail{
		PullRequest: gh.PullRequest{Number: 14586, MergeStateStatus: "BLOCKED", HeadRepoSlug: "kgni/ghostty"},
		Checks: []gh.CheckRun{
			{Name: "valgrind", Workflow: "Test", Status: "COMPLETED", Conclusion: "TIMED_OUT", URL: "u", StartedAt: at},
			{Name: "lint", Status: "WAITING"},
			{Name: "future", Status: "BRAND_NEW", Conclusion: "ALSO_NEW"},
		},
		FetchedAt: at,
	})
	d, err := client.GetPullRequest(ctx, connect.NewRequest(&v1.GetPullRequestRequest{RepoSlug: "ghostty-org/ghostty", Number: 14586}))
	if err != nil {
		t.Fatal(err)
	}
	checks := d.Msg.GetChecks()
	if d.Msg.GetPullRequest().GetMergeStateStatus() != v1.MergeStateStatus_MERGE_STATE_STATUS_BLOCKED ||
		d.Msg.GetPullRequest().GetHeadRepoSlug() != "kgni/ghostty" || len(checks) != 3 ||
		checks[0].GetConclusion() != v1.CheckConclusion_CHECK_CONCLUSION_TIMED_OUT ||
		checks[0].GetStatus() != v1.CheckStatus_CHECK_STATUS_COMPLETED || checks[0].GetCompletedAt() != nil ||
		checks[1].GetStatus() != v1.CheckStatus_CHECK_STATUS_WAITING ||
		checks[1].GetConclusion() != v1.CheckConclusion_CHECK_CONCLUSION_UNSPECIFIED ||
		checks[2].GetStatus() != v1.CheckStatus_CHECK_STATUS_UNSPECIFIED {
		t.Errorf("detail = %v", d.Msg)
	}
}

func TestGhErrorCodes(t *testing.T) {
	store, client := newGhTest(t)
	ctx := context.Background()
	tests := []struct {
		err  error
		want connect.Code
	}{
		{fmt.Errorf("%w: x", gh.ErrNotFound), connect.CodeNotFound},
		{fmt.Errorf("%w: x", gh.ErrNotAuthenticated), connect.CodeFailedPrecondition},
		{fmt.Errorf("%w: Resource not accessible by integration", gh.ErrPermissionDenied), connect.CodePermissionDenied},
		// Wrapped by the store (a revert that could not confirm the merge, or whose outcome
		// is unknown): the cause's code.
		{fmt.Errorf("pull request #1: cannot confirm it is merged: %w", &gh.RateLimitError{Msg: "exceeded"}), connect.CodeResourceExhausted},
		{fmt.Errorf("pull request #1: check GitHub before trying again: %w", fmt.Errorf("%w: 502", gh.ErrServerTimeout)), connect.CodeUnavailable},
		{&gh.RateLimitError{Secondary: true, Msg: "slow down"}, connect.CodeResourceExhausted},
		{fmt.Errorf("%w: x", gh.ErrNetwork), connect.CodeUnavailable},
		{fmt.Errorf("%w: x", gh.ErrServerTimeout), connect.CodeUnavailable},
		{fmt.Errorf("%w: x", gh.ErrFailedPrecondition), connect.CodeFailedPrecondition},
		{errors.New("gh exited 2: odd"), connect.CodeUnknown},
	}
	for _, tt := range tests {
		store.SetError(tt.err)
		_, err := client.GetPullRequest(ctx, connect.NewRequest(&v1.GetPullRequestRequest{RepoSlug: "a/b", Number: 1}))
		if got := connect.CodeOf(err); got != tt.want {
			t.Errorf("%v: code = %v, want %v", tt.err, got, tt.want)
		}
	}
}
