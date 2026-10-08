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

func newGhTest(t *testing.T) (*ghtest.Store, codefoundryv1connect.GhServiceClient, chan struct{}) {
	t.Helper()
	b := bus.New()
	store := ghtest.New(b)
	done := make(chan struct{})
	route := NewGh(store, b, done).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return store, codefoundryv1connect.NewGhServiceClient(srv.Client(), srv.URL), done
}

func TestGhReads(t *testing.T) {
	store, client, _ := newGhTest(t)
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
	store.SetRepo(gh.RepoState{
		Slug: "ghostty-org/ghostty", Tracked: true, TotalCount: 129, FetchedAt: at, LastError: "stale",
		PullRequests: []gh.PullRequest{{
			Number: 14586, Title: "i18n", Author: "kgni", HeadRef: "i18n/da_DK", HeadSHA: "7b60f9b", BaseRef: "main",
			Draft: true, ReviewDecision: gh.ReviewRequired, Mergeable: gh.MergeableConflicting,
			IsCrossRepository: true, URL: "https://github.com/ghostty-org/ghostty/pull/14586", UpdatedAt: at,
			Checks: gh.CheckRollup{State: gh.RollupFailure, Total: 10, Passed: 6, Failed: 1, Pending: 2, Skipped: 1},
		}},
	})

	v, err = client.GetViewer(ctx, connect.NewRequest(&v1.GetViewerRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if v.Msg.GetViewer().GetLogin() != "octocat" || !v.Msg.GetFetchedAt().AsTime().Equal(at) {
		t.Errorf("viewer = %v", v.Msg)
	}

	list, err := client.ListPullRequests(ctx, connect.NewRequest(&v1.ListPullRequestsRequest{RepoSlug: "Ghostty-Org/Ghostty"}))
	if err != nil {
		t.Fatal(err)
	}
	m := list.Msg
	if !m.GetTracked() || m.GetTotalCount() != 129 || m.GetLastError() != "stale" || len(m.GetPullRequests()) != 1 {
		t.Fatalf("list = %v", m)
	}
	pr := m.GetPullRequests()[0]
	if pr.GetRepoSlug() != "ghostty-org/ghostty" || pr.GetNumber() != 14586 || !pr.GetDraft() ||
		pr.GetReviewDecision() != v1.ReviewDecision_REVIEW_DECISION_REVIEW_REQUIRED ||
		pr.GetMergeable() != v1.Mergeable_MERGEABLE_CONFLICTING ||
		pr.GetMergeStateStatus() != v1.MergeStateStatus_MERGE_STATE_STATUS_UNSPECIFIED ||
		pr.GetChecks().GetState() != v1.CheckRollupState_CHECK_ROLLUP_STATE_FAILURE ||
		pr.GetChecks().GetPending() != 2 || !pr.GetUpdatedAt().AsTime().Equal(at) {
		t.Errorf("pr = %v", pr)
	}

	unknown, err := client.ListPullRequests(ctx, connect.NewRequest(&v1.ListPullRequestsRequest{RepoSlug: "a/b"}))
	if err != nil || unknown.Msg.GetTracked() || unknown.Msg.GetFetchedAt() != nil || len(unknown.Msg.GetPullRequests()) != 0 {
		t.Errorf("unknown repo = %v, %v", unknown.Msg, err)
	}
	_, err = client.ListPullRequests(ctx, connect.NewRequest(&v1.ListPullRequestsRequest{RepoSlug: "nope"}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("bad slug err = %v", err)
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

	store.SetChecks("ghostty-org/ghostty", "main", gh.RefChecks{SHA: "a60e9e2", Rollup: gh.CheckRollup{State: gh.RollupSuccess, Total: 1, Passed: 1}, FetchedAt: at})
	c, err := client.ListChecks(ctx, connect.NewRequest(&v1.ListChecksRequest{RepoSlug: "ghostty-org/ghostty", Ref: "main"}))
	if err != nil || c.Msg.GetSha() != "a60e9e2" || c.Msg.GetRollup().GetState() != v1.CheckRollupState_CHECK_ROLLUP_STATE_SUCCESS {
		t.Errorf("checks = %v, %v", c.Msg, err)
	}
}

func TestGhErrorCodes(t *testing.T) {
	store, client, _ := newGhTest(t)
	ctx := context.Background()
	tests := []struct {
		err  error
		want connect.Code
	}{
		{fmt.Errorf("%w: x", gh.ErrNotFound), connect.CodeNotFound},
		{fmt.Errorf("%w: x", gh.ErrNotAuthenticated), connect.CodeFailedPrecondition},
		{&gh.RateLimitError{Secondary: true, Msg: "slow down"}, connect.CodeResourceExhausted},
		{fmt.Errorf("%w: x", gh.ErrNetwork), connect.CodeUnavailable},
		{fmt.Errorf("%w: x", gh.ErrServerTimeout), connect.CodeUnavailable},
		{errors.New("gh exited 2: odd"), connect.CodeUnknown},
	}
	for _, tt := range tests {
		store.SetError(tt.err)
		_, err := client.GetPullRequest(ctx, connect.NewRequest(&v1.GetPullRequestRequest{RepoSlug: "a/b", Number: 1}))
		if got := connect.CodeOf(err); got != tt.want {
			t.Errorf("%v: code = %v, want %v", tt.err, got, tt.want)
		}
		_, err = client.Refresh(ctx, connect.NewRequest(&v1.RefreshGhRequest{RepoSlug: "a/b"}))
		if got := connect.CodeOf(err); got != tt.want {
			t.Errorf("refresh %v: code = %v, want %v", tt.err, got, tt.want)
		}
	}
}

func TestGhTrackAndWatch(t *testing.T) {
	store, client, done := newGhTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	stream, err := client.Watch(ctx, connect.NewRequest(&v1.WatchGhRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	// Watch returns once headers arrive, which the handler sends after subscribing.
	at := time.Date(2026, 10, 8, 6, 0, 0, 0, time.UTC)
	store.SetViewer(gh.ViewerState{Authenticated: true, FetchedAt: at})
	if !stream.Receive() {
		t.Fatalf("no event: %v", stream.Err())
	}
	if got := stream.Msg().GetViewerUpdated().GetFetchedAt().AsTime(); !got.Equal(at) {
		t.Errorf("viewer event fetched_at = %v", got)
	}

	if _, err := client.Track(ctx, connect.NewRequest(&v1.TrackGhRepoRequest{RepoSlug: "Ghostty-Org/Ghostty"})); err != nil {
		t.Fatal(err)
	}
	for stream.Receive() {
		if ev := stream.Msg().GetPullRequestsUpdated(); ev != nil {
			if ev.GetRepoSlug() != "ghostty-org/ghostty" || ev.GetFetchedAt() != nil {
				t.Errorf("pr event = %v", ev)
			}
			break
		}
	}
	if _, err := client.Untrack(ctx, connect.NewRequest(&v1.UntrackGhRepoRequest{RepoSlug: "ghostty-org/ghostty"})); err != nil {
		t.Fatal(err)
	}
	_, err = client.Track(ctx, connect.NewRequest(&v1.TrackGhRepoRequest{RepoSlug: "bad"}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("bad slug err = %v", err)
	}
	if got := fmt.Sprint(store.Calls()); got != "[track ghostty-org/ghostty untrack ghostty-org/ghostty]" {
		t.Errorf("calls = %s", got)
	}

	// Daemon shutdown ends the stream cleanly.
	close(done)
	for stream.Receive() {
	}
	if err := stream.Err(); err != nil {
		t.Errorf("stream ended with %v, want clean end", err)
	}
}
