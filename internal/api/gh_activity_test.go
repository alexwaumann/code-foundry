package api

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

func TestGhDashboardFiltersToTracked(t *testing.T) {
	store, client, _ := newGhTest(t)
	ctx := context.Background()
	at := time.Date(2026, 10, 8, 6, 0, 0, 0, time.UTC)
	store.SetViewer(gh.ViewerState{Viewer: &gh.Viewer{Login: "octocat"}, Authenticated: true, FetchedAt: at})
	_ = store.Track("o/tracked")
	pr := func(repo string, n int, state gh.PullRequestState) gh.PullRequest {
		return gh.PullRequest{Repo: repo, Number: n, Title: "t", State: state, CreatedAt: at, UpdatedAt: at,
			ReviewDecision: gh.ReviewApproved, Checks: gh.CheckRollup{State: gh.RollupSuccess, Total: 1, Passed: 1}}
	}
	merged := pr("o/tracked", 3, gh.PullRequestMerged)
	merged.MergedAt = at
	store.SetDashboard(gh.Dashboard{
		Authored:        []gh.PullRequest{pr("o/tracked", 1, gh.PullRequestOpen), pr("x/other", 2, gh.PullRequestOpen)},
		ReviewRequested: []gh.PullRequest{pr("x/other", 9, gh.PullRequestOpen)},
		RecentlyMerged:  []gh.PullRequest{merged},
		FetchedAt:       at,
		LastError:       "partial",
		Stats: gh.MonthlyStats{
			ThisMonth:     gh.MonthCount{Month: "2026-10", Commits: 16, Merged: 2},
			LastMonth:     gh.MonthCount{Month: "2026-09", Commits: 463, Merged: 38},
			CommitsSource: gh.CommitsFromSearch, FetchedAt: at,
		},
	})

	res, err := client.GetDashboard(ctx, connect.NewRequest(&v1.GetDashboardRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	m := res.Msg
	if m.GetViewer().GetLogin() != "octocat" || !m.GetAuthenticated() || m.GetLastError() != "partial" ||
		!m.GetFetchedAt().AsTime().Equal(at) || len(m.GetTrackedSlugs()) != 1 || m.GetTrackedSlugs()[0] != "o/tracked" {
		t.Errorf("header = %v", m)
	}
	if len(m.GetAuthored()) != 1 || m.GetAuthored()[0].GetNumber() != 1 || len(m.GetReviewRequested()) != 0 ||
		len(m.GetRecentlyMerged()) != 1 {
		t.Errorf("filtered lists: %d/%d/%d", len(m.GetAuthored()), len(m.GetReviewRequested()), len(m.GetRecentlyMerged()))
	}
	p := m.GetAuthored()[0]
	if p.GetRepoSlug() != "o/tracked" || p.GetState() != v1.PullRequestState_PULL_REQUEST_STATE_OPEN ||
		p.GetCreatedAt() == nil || p.GetReviewDecision() != v1.ReviewDecision_REVIEW_DECISION_APPROVED ||
		p.GetChecks().GetState() != v1.CheckRollupState_CHECK_ROLLUP_STATE_SUCCESS {
		t.Errorf("authored PR = %v", p)
	}
	if mp := m.GetRecentlyMerged()[0]; mp.GetState() != v1.PullRequestState_PULL_REQUEST_STATE_MERGED || mp.GetMergedAt() == nil {
		t.Errorf("merged PR = %v", mp)
	}
	s := m.GetStats()
	if s.GetThisMonth().GetCommits() != 16 || s.GetLastMonth().GetMerged() != 38 || s.GetThisMonth().GetMonth() != "2026-10" ||
		s.GetCommitsSource() != "search" || s.GetFetchedAt() == nil {
		t.Errorf("stats = %v", s)
	}

	all, err := client.GetDashboard(ctx, connect.NewRequest(&v1.GetDashboardRequest{IncludeUntracked: true}))
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Msg.GetAuthored()) != 2 || len(all.Msg.GetReviewRequested()) != 1 {
		t.Errorf("include_untracked lists: %d/%d", len(all.Msg.GetAuthored()), len(all.Msg.GetReviewRequested()))
	}
}

func TestGhRepoActivityAndBranch(t *testing.T) {
	store, client, _ := newGhTest(t)
	ctx := context.Background()
	at := time.Date(2026, 10, 8, 6, 0, 0, 0, time.UTC)

	// Unknown repository: empty, no default branch yet.
	res, err := client.GetRepoActivity(ctx, connect.NewRequest(&v1.GetRepoActivityRequest{RepoSlug: "O/Repo"}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Msg.GetRepoSlug() != "o/repo" || res.Msg.GetDefaultBranch() != nil || res.Msg.GetStats().GetFetchedAt() != nil {
		t.Errorf("empty activity = %v", res.Msg)
	}

	store.SetActivity("o/repo", gh.RepoActivity{
		Stats: gh.MonthlyStats{ThisMonth: gh.MonthCount{Month: "2026-10", Commits: 3, Merged: 1}, FetchedAt: at},
		DefaultBranch: gh.BranchCI{
			Branch: "main", SHA: "abc", Headline: "fix", CommittedAt: at, FetchedAt: at,
			Rollup:  gh.CheckRollup{State: gh.RollupFailure, Total: 3, Passed: 1, Failed: 2},
			Failing: []gh.CheckRun{{Name: "Jenkins", Status: gh.StatusCompleted, Conclusion: gh.ConclusionFailure, URL: "https://ci/1"}},
		},
	})
	store.SetDashboard(gh.Dashboard{RecentlyMerged: []gh.PullRequest{
		{Repo: "o/repo", Number: 7, State: gh.PullRequestMerged, MergedAt: at},
		{Repo: "o/else", Number: 8, State: gh.PullRequestMerged, MergedAt: at},
	}})
	res, err = client.GetRepoActivity(ctx, connect.NewRequest(&v1.GetRepoActivityRequest{RepoSlug: "o/repo"}))
	if err != nil {
		t.Fatal(err)
	}
	db := res.Msg.GetDefaultBranch()
	if db.GetBranch() != "main" || db.GetRollup().GetFailed() != 2 || len(db.GetFailing()) != 1 ||
		db.GetFailing()[0].GetUrl() != "https://ci/1" || db.GetCommittedAt() == nil {
		t.Errorf("default branch = %v", db)
	}
	if res.Msg.GetStats().GetThisMonth().GetCommits() != 3 || len(res.Msg.GetRecentlyMerged()) != 1 ||
		res.Msg.GetRecentlyMerged()[0].GetNumber() != 7 {
		t.Errorf("activity = %v", res.Msg)
	}
	if _, err := client.GetRepoActivity(ctx, connect.NewRequest(&v1.GetRepoActivityRequest{RepoSlug: "bad"})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("bad slug err = %v", err)
	}

	store.SetBranchPullRequests(gh.BranchPullRequests{Slug: "o/repo", HeadRef: "feat", FetchedAt: at,
		PullRequests: []gh.PullRequest{{Repo: "o/repo", Number: 5, State: gh.PullRequestOpen, HeadRef: "feat"}}})
	br, err := client.GetBranchPullRequests(ctx, connect.NewRequest(&v1.GetBranchPullRequestsRequest{RepoSlug: "o/repo", HeadRef: "feat"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(br.Msg.GetPullRequests()) != 1 || br.Msg.GetPullRequests()[0].GetRepoSlug() != "o/repo" || br.Msg.GetFetchedAt() == nil {
		t.Errorf("branch = %v", br.Msg)
	}
	if _, err := client.GetBranchPullRequests(ctx, connect.NewRequest(&v1.GetBranchPullRequestsRequest{RepoSlug: "o/repo"})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("empty head err = %v", err)
	}
}

func TestRepoGetWorktreeDetail(t *testing.T) {
	fake, c := newRepoServer(t)
	ctx := context.Background()
	reg, err := c.Register(ctx, connect.NewRequest(&v1.RegisterRepoRequest{Path: "/code/proj"}))
	if err != nil {
		t.Fatal(err)
	}
	id := reg.Msg.GetRepo().GetId()
	at := time.Unix(1700000000, 0)
	fake.SetDetail(repo.WorktreeDetail{
		RepoID: id, Path: "/code/proj", BaseRef: "origin/main", MergeBase: "m", Head: "h", LogTotal: 101, ComputedAt: at,
		Files: []repo.FileChange{{Path: "b", OldPath: "a", Status: "R", Added: 1, Deleted: 2, Uncommitted: true},
			{Path: "d/", Status: "?", IsDir: true, Uncommitted: true}},
		Log: []repo.LogEntry{{SHA: "h", ShortSHA: "h", Subject: "s", AuthorName: "A", AuthorEmail: "a@x", AuthoredAt: at}},
	})
	res, err := c.GetWorktreeDetail(ctx, connect.NewRequest(&v1.GetWorktreeDetailRequest{RepoId: id, Path: "/code/proj"}))
	if err != nil {
		t.Fatal(err)
	}
	d := res.Msg.GetDetail()
	if d.GetBaseRef() != "origin/main" || d.GetLogTotal() != 101 || len(d.GetFiles()) != 2 || len(d.GetLog()) != 1 ||
		d.GetFiles()[0].GetOldPath() != "a" || !d.GetFiles()[1].GetIsDir() || d.GetLog()[0].GetAuthoredAt() == nil ||
		!d.GetComputedAt().AsTime().Equal(at) {
		t.Errorf("detail = %v", d)
	}
	if _, err := c.GetWorktreeDetail(ctx, connect.NewRequest(&v1.GetWorktreeDetailRequest{RepoId: id, Path: "/nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown worktree err = %v", err)
	}
}
