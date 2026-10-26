package api

import (
	"context"
	"fmt"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

func TestGhDashboardListsEveryRepository(t *testing.T) {
	store, client, _ := newGhTest(t)
	ctx := context.Background()
	at := time.Date(2026, 10, 8, 6, 0, 0, 0, time.UTC)
	store.SetViewer(gh.ViewerState{Viewer: &gh.Viewer{Login: "octocat"}, Authenticated: true, FetchedAt: at})
	_ = store.Track("o/tracked")
	pr := func(slug string, n int, state gh.PullRequestState) gh.PullRequest {
		return gh.PullRequest{Repo: slug, Number: n, Title: "t", State: state, CreatedAt: at, UpdatedAt: at,
			ReviewDecision: gh.ReviewApproved, Checks: gh.CheckRollup{State: gh.RollupSuccess, Total: 1, Passed: 1}}
	}
	merged := pr("o/tracked", 3, gh.PullRequestMerged)
	merged.MergedAt = at
	otherMerged := pr("x/other", 6, gh.PullRequestMerged)
	otherMerged.MergedAt = at
	reviewed := pr("x/other", 5, gh.PullRequestOpen)
	reviewed.HeadSHA = "head5"
	reviewed.LatestReviews = []gh.Review{
		{Author: "octocat", State: "COMMENTED", SubmittedAt: at, CommitSHA: "old5"},
		{Author: "hubot", State: "APPROVED", SubmittedAt: at, CommitSHA: "head5"},
		{Author: "ghost", State: "APPROVED"}, // cached before commits were fetched
	}
	store.SetDashboard(gh.Dashboard{
		Authored:        []gh.PullRequest{pr("o/tracked", 1, gh.PullRequestOpen), pr("x/other", 2, gh.PullRequestOpen)},
		ReviewRequested: []gh.PullRequest{pr("x/other", 9, gh.PullRequestOpen)},
		Reviewed:        []gh.PullRequest{pr("o/tracked", 4, gh.PullRequestOpen), reviewed},
		RecentlyMerged:  []gh.PullRequest{merged, otherMerged},
		FetchedAt:       at,
		LastError:       "partial",
		Stats: gh.MonthlyStats{
			Months:        sixMonths(),
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
	// Every list holds every repository, tracked or not.
	numbers := func(prs []*v1.PullRequest) string {
		var out []string
		for _, p := range prs {
			out = append(out, fmt.Sprintf("%s#%d", p.GetRepoSlug(), p.GetNumber()))
		}
		return fmt.Sprint(out)
	}
	lists := []struct {
		name string
		got  []*v1.PullRequest
		want string
	}{
		{"authored", m.GetAuthored(), "[o/tracked#1 x/other#2]"},
		{"review requested", m.GetReviewRequested(), "[x/other#9]"},
		{"reviewed", m.GetReviewed(), "[o/tracked#4 x/other#5]"},
		{"recently merged", m.GetRecentlyMerged(), "[o/tracked#3 x/other#6]"},
	}
	for _, l := range lists {
		if got := numbers(l.got); got != l.want {
			t.Errorf("%s = %s, want %s", l.name, got, l.want)
		}
	}
	if m.GetDashboardsDisabled() {
		t.Error("dashboards disabled")
	}
	// Latest reviews carry the commit they were submitted on.
	r := m.GetReviewed()[1]
	var reviews []string
	for _, lr := range r.GetLatestReviews() {
		reviews = append(reviews, lr.GetAuthor()+"@"+lr.GetCommitSha())
	}
	if r.GetHeadSha() != "head5" || fmt.Sprint(reviews) != "[octocat@old5 hubot@head5 ghost@]" {
		t.Errorf("reviewed head %s, latest reviews %v", r.GetHeadSha(), reviews)
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
	if ms := s.GetMonths(); len(ms) != 6 || ms[0].GetCommits() != 16 || ms[1].GetMerged() != 38 || ms[0].GetMonth() != "2026-10" ||
		ms[5].GetMonth() != "2026-05" || s.GetCommitsSource() != "search" || s.GetFetchedAt() == nil {
		t.Errorf("stats = %v", s)
	}

	//lint:ignore SA1019 the deprecated field must still be accepted, and change nothing
	all, err := client.GetDashboard(ctx, connect.NewRequest(&v1.GetDashboardRequest{IncludeUntracked: true}))
	if err != nil {
		t.Fatal(err)
	}
	// include_untracked is deprecated and changes nothing.
	if numbers(all.Msg.GetAuthored()) != numbers(m.GetAuthored()) || numbers(all.Msg.GetReviewRequested()) != numbers(m.GetReviewRequested()) ||
		numbers(all.Msg.GetReviewed()) != numbers(m.GetReviewed()) || numbers(all.Msg.GetRecentlyMerged()) != numbers(m.GetRecentlyMerged()) {
		t.Errorf("include_untracked lists differ: %s %s", numbers(all.Msg.GetAuthored()), numbers(all.Msg.GetReviewed()))
	}

	// A renamed repository: search results carry its new name; they are the tracked
	// slug's, under that slug.
	store.SetCanonicalSlug("o/tracked", "neworg/tracked")
	store.SetDashboard(gh.Dashboard{
		Authored:       []gh.PullRequest{pr("neworg/tracked", 11, gh.PullRequestOpen), pr("x/other", 2, gh.PullRequestOpen)},
		RecentlyMerged: []gh.PullRequest{pr("neworg/tracked", 12, gh.PullRequestMerged)},
	})
	moved, err := client.GetDashboard(ctx, connect.NewRequest(&v1.GetDashboardRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if a := numbers(moved.Msg.GetAuthored()); a != "[o/tracked#11 x/other#2]" {
		t.Errorf("renamed repository's authored = %v", a)
	}
	act, err := client.GetRepoActivity(ctx, connect.NewRequest(&v1.GetRepoActivityRequest{RepoSlug: "o/tracked"}))
	if err != nil {
		t.Fatal(err)
	}
	if rm := act.Msg.GetRecentlyMerged(); len(rm) != 1 || rm[0].GetNumber() != 12 {
		t.Errorf("renamed repository's recently merged = %v", rm)
	}

	store.SetDashboard(gh.Dashboard{Disabled: true, FetchedAt: at})
	off, err := client.GetDashboard(ctx, connect.NewRequest(&v1.GetDashboardRequest{}))
	if err != nil || !off.Msg.GetDashboardsDisabled() || len(off.Msg.GetAuthored()) != 0 {
		t.Errorf("disabled = %v, %v", off.Msg, err)
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
		Stats: gh.MonthlyStats{Months: []gh.MonthCount{{Month: "2026-10", Commits: 3, Merged: 1}}, FetchedAt: at},
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
	if ms := res.Msg.GetStats().GetMonths(); len(ms) != 1 || ms[0].GetCommits() != 3 || len(res.Msg.GetRecentlyMerged()) != 1 ||
		res.Msg.GetRecentlyMerged()[0].GetNumber() != 7 {
		t.Errorf("activity = %v", res.Msg)
	}
	// A repository that failed in the last poll keeps its last state, with the error.
	store.SetActivity("o/gone", gh.RepoActivity{DefaultBranch: gh.BranchCI{LastError: "not found on github"}})
	gone, err := client.GetRepoActivity(ctx, connect.NewRequest(&v1.GetRepoActivityRequest{RepoSlug: "o/gone"}))
	if err != nil || gone.Msg.GetDefaultBranch().GetLastError() != "not found on github" {
		t.Errorf("failed repository = %v, %v", gone.Msg, err)
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

func TestProjectGetWorktreeDetail(t *testing.T) {
	fake, c := newProjectServer(t)
	ctx := context.Background()
	reg, err := c.Register(ctx, connect.NewRequest(&v1.RegisterProjectRequest{Path: "/code/proj"}))
	if err != nil {
		t.Fatal(err)
	}
	id := reg.Msg.GetProject().GetId()
	at := time.Unix(1700000000, 0)
	fake.SetDetail(project.WorktreeDetail{
		ProjectID: id, Path: "/code/proj", BaseRef: "origin/main", MergeBase: "m", Head: "h", LogTotal: 101, ComputedAt: at,
		Files: []project.FileChange{{Path: "b", OldPath: "a", Status: "R", Added: 1, Deleted: 2, Uncommitted: true},
			{Path: "d/notes.md", Status: "?", Added: 3, Uncommitted: true}},
		Log: []project.LogEntry{{SHA: "h", ShortSHA: "h", Subject: "s", AuthorName: "A", AuthorEmail: "a@x", AuthoredAt: at}},
	})
	res, err := c.GetWorktreeDetail(ctx, connect.NewRequest(&v1.GetWorktreeDetailRequest{ProjectId: id, Path: "/code/proj"}))
	if err != nil {
		t.Fatal(err)
	}
	d := res.Msg.GetDetail()
	if d.GetBaseRef() != "origin/main" || d.GetLogTotal() != 101 || len(d.GetFiles()) != 2 || len(d.GetLog()) != 1 ||
		d.GetFiles()[0].GetOldPath() != "a" || d.GetFiles()[1].GetStatus() != "?" || d.GetFiles()[1].GetAdded() != 3 || d.GetLog()[0].GetAuthoredAt() == nil ||
		!d.GetComputedAt().AsTime().Equal(at) {
		t.Errorf("detail = %v", d)
	}
	if _, err := c.GetWorktreeDetail(ctx, connect.NewRequest(&v1.GetWorktreeDetailRequest{ProjectId: id, Path: "/nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown worktree err = %v", err)
	}
}

// sixMonths is a dashboard's stats, newest first.
func sixMonths() []gh.MonthCount {
	return []gh.MonthCount{
		{Month: "2026-10", Commits: 16, Merged: 2, Source: gh.CommitsFromSearch},
		{Month: "2026-09", Commits: 463, Merged: 38, Source: gh.CommitsFromSearch},
		{Month: "2026-08", Commits: 120, Merged: 9, Source: gh.CommitsFromSearch},
		{Month: "2026-07", Commits: 0, Merged: 0, Source: gh.CommitsFromSearch},
		{Month: "2026-06", Commits: 7, Merged: 1, Source: gh.CommitsFromSearch},
		{Month: "2026-05", Commits: 2, Merged: 0, Source: gh.CommitsFromSearch},
	}
}

func TestStatsToProto(t *testing.T) {
	at := time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)
	tests := []struct {
		name string
		in   gh.MonthlyStats
		want string // months as month/commits/merged, newest first
		src  string
		err  string
	}{
		{name: "never fetched", in: gh.MonthlyStats{}, want: "[]"},
		{name: "six months, newest first", in: gh.MonthlyStats{Months: sixMonths(), CommitsSource: gh.CommitsFromSearch, FetchedAt: at, ClosedAt: at},
			want: "[2026-10/16/2 2026-09/463/38 2026-08/120/9 2026-07/0/0 2026-06/7/1 2026-05/2/0]", src: "search"},
		{name: "fallback source and error kept", in: gh.MonthlyStats{Months: sixMonths()[:2], CommitsSource: gh.CommitsFromContributions, LastError: "boom"},
			want: "[2026-10/16/2 2026-09/463/38]", src: "contributions", err: "boom"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := statsToProto(tt.in)
			got := []string{}
			for _, m := range p.GetMonths() {
				got = append(got, fmt.Sprintf("%s/%d/%d", m.GetMonth(), m.GetCommits(), m.GetMerged()))
			}
			if fmt.Sprint(got) != tt.want || p.GetCommitsSource() != tt.src || p.GetLastError() != tt.err ||
				(p.GetFetchedAt() != nil) != !tt.in.FetchedAt.IsZero() {
				t.Errorf("got %v %q %q %v", got, p.GetCommitsSource(), p.GetLastError(), p.GetFetchedAt())
			}
		})
	}
}
