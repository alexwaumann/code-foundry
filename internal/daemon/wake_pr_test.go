package daemon

import (
	"context"
	"io"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/gh/ghtest"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

type recordingPRWaker struct {
	mu     sync.Mutex
	events []thread.PullRequestEvent
}

func (w *recordingPRWaker) PullRequestChanged(e thread.PullRequestEvent) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.events = append(w.events, e)
}

func (w *recordingPRWaker) got() []thread.PullRequestEvent {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.events)
}

func TestWakePullRequests(t *testing.T) {
	b := bus.New()
	g := ghtest.New(b)
	w := &recordingPRWaker{}
	stop := startWakePullRequests(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)), w, b)
	defer stop()
	at := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	g.ChangePullRequest(gh.PullRequestChanged{
		Slug: "alexwaumann/code-foundry", Number: 210, URL: "https://github.com/alexwaumann/code-foundry/pull/210", HeadRef: "cf/x",
		PullRequest: gh.PullRequest{
			Number: 210, Title: "PR A", Repo: "alexwaumann/code-foundry", State: gh.PullRequestMerged, HeadSHA: "b",
			ReviewDecision: gh.ReviewApproved, Checks: gh.CheckRollup{State: gh.RollupSuccess, Total: 4, Passed: 4},
			Reviews: 1, Comments: 2, ReviewRequests: []string{"org/team"}, MergedAt: at,
			LatestReviews: []gh.Review{{Author: "octocat", State: "APPROVED", SubmittedAt: at}},
		},
		Changes: []gh.Change{
			{Kind: gh.ChangeMerged, OldState: gh.PullRequestOpen, NewState: gh.PullRequestMerged},
			{Kind: gh.ChangeHeadPushed, OldHeadSHA: "a", NewHeadSHA: "b"},
			{Kind: gh.ChangeChecks, OldChecks: gh.CheckRollup{State: gh.RollupPending, Total: 4, Passed: 3, Pending: 1},
				NewChecks: gh.CheckRollup{State: gh.RollupSuccess, Total: 4, Passed: 4}},
			{Kind: gh.ChangeReviewDecision, OldReviewDecision: gh.ReviewRequired, NewReviewDecision: gh.ReviewApproved},
			{Kind: gh.ChangeComments, OldCount: 1, NewCount: 2},
			{Kind: gh.ChangeReviewRequested, Requested: []string{"org/team"}, Viewer: true},
			{Kind: gh.ChangeDraft, OldDraft: true},
			{Kind: gh.ChangeTitle, OldTitle: "x", NewTitle: "PR A"},
		},
	})
	deadline := time.Now().Add(2 * time.Second)
	for len(w.got()) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("nothing forwarded")
		}
		time.Sleep(5 * time.Millisecond)
	}
	e := w.got()[0]
	p := e.PullRequest
	if p.Target() != "alexwaumann/code-foundry#210" || p.State != "merged" || p.HeadRef != "cf/x" || p.URL == "" || p.Title != "PR A" ||
		p.ReviewDecision != "APPROVED" || p.Checks != (thread.PRChecks{State: "SUCCESS", Total: 4, Passed: 4}) || p.Comments != 2 ||
		!p.MergedAt.Equal(at) || len(p.LatestReviews) != 1 || p.LatestReviews[0].Author != "octocat" || !slices.Equal(p.ReviewRequests, []string{"org/team"}) {
		t.Errorf("pull request = %+v", p)
	}
	c := e.Changes
	if len(c) != 8 || c[0].Kind != thread.PRChangeMerged || c[0].OldState != "open" || c[0].NewState != "merged" ||
		c[1].NewHeadSHA != "b" || c[2].OldChecks.Pending != 1 || c[2].NewChecks.State != "SUCCESS" ||
		c[3].OldReviewDecision != "REVIEW_REQUIRED" || c[4].NewCount != 2 || !c[5].ViewerRequested || c[5].Requested[0] != "org/team" ||
		!c[6].OldDraft || c[7].NewTitle != "PR A" {
		t.Errorf("changes = %+v", c)
	}
}

func TestPullRequestForWake(t *testing.T) {
	g := ghtest.New(nil)
	g.SetDashboard(gh.Dashboard{Authored: []gh.PullRequest{{Number: 7, Title: "Retry", Repo: "acme/web", State: gh.PullRequestOpen,
		Checks: gh.CheckRollup{State: gh.RollupPending, Total: 2, Pending: 2}}}})
	get := pullRequestForWake(g)
	p, ok := get(context.Background(), "acme/web#7")
	if !ok || p.Title != "Retry" || p.State != "open" || p.Checks.Pending != 2 || p.Target() != "acme/web#7" {
		t.Errorf("acme/web#7 = %+v, %v", p, ok)
	}
	for _, target := range []string{"acme/web#8", "acme/web", "acme/web#x"} {
		if _, ok := get(context.Background(), target); ok {
			t.Errorf("%s was found", target)
		}
	}
}

func TestWatchPullRequestsForWake(t *testing.T) {
	g := ghtest.New(nil)
	watch := watchPullRequestsForWake(slog.New(slog.NewTextHandler(io.Discard, nil)), g)
	watch([]string{"acme/web#7", "acme/api#12"})
	if got := g.Watched(); !slices.Equal(got, []string{"acme/api#12", "acme/web#7"}) {
		t.Errorf("watched %v", got)
	}
	watch(nil)
	if got := g.Watched(); len(got) != 0 {
		t.Errorf("watched %v after none", got)
	}
	if calls := g.Calls(); !slices.Equal(calls, []string{"watch acme/api#12 acme/web#7", "watch"}) {
		t.Errorf("calls %v", calls)
	}
}
