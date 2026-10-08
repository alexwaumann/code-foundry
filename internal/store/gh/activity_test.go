package gh

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// restRunner adds REST to fakeRunner.
type restRunner struct {
	*fakeRunner
	mu   sync.Mutex
	rest func(path string, params map[string]string) (json.RawMessage, error)
	qs   []string
}

func (r *restRunner) REST(_ context.Context, path string, params map[string]string) (json.RawMessage, error) {
	r.mu.Lock()
	r.qs = append(r.qs, params["q"])
	h := r.rest
	r.mu.Unlock()
	return h(path, params)
}

// activityHandler serves the phase 3a fixtures; prPage1 is the PR list page one (with
// its default branch).
func activityHandler(t *testing.T, prPage1 string) func(op string, vars map[string]any) (json.RawMessage, error) {
	base := fixtureHandler(t)
	page1 := fixtureData(t, prPage1)
	fx := map[string]json.RawMessage{}
	for _, n := range []string{"search_authored", "search_review", "search_merged", "viewer_stats", "repo_stats",
		"user_id", "branch_pull_requests_merged", "checks_default_branch_deno_page2"} {
		fx[n] = fixtureData(t, n+".json")
	}
	return func(op string, vars map[string]any) (json.RawMessage, error) {
		_, paged := vars["after"]
		switch op {
		case "PullRequests":
			if !paged {
				if vars["withDefaultBranch"] != true {
					return nil, fmt.Errorf("page one without withDefaultBranch")
				}
				return page1, nil
			}
		case "SearchPullRequests":
			q := vars["q"].(string)
			switch {
			case strings.Contains(q, "review-requested:"):
				return fx["search_review"], nil
			case strings.Contains(q, "is:merged"):
				return fx["search_merged"], nil
			default:
				return fx["search_authored"], nil
			}
		case "ViewerStats":
			return fx["viewer_stats"], nil
		case "RepoStats":
			return fx["repo_stats"], nil
		case "UserID":
			return fx["user_id"], nil
		case "BranchPullRequests":
			return fx["branch_pull_requests_merged"], nil
		case "Checks":
			if paged {
				return fx["checks_default_branch_deno_page2"], nil
			}
		}
		return base(op, vars)
	}
}

func activityOptions(db DB, r Runner, b *bus.Bus) Options {
	o := testOptions(db, r, b)
	o.DashboardInterval, o.StatsInterval = time.Hour, time.Hour
	return o
}

func TestActivityPollsCachesAndRestarts(t *testing.T) {
	db := openTestDB(t)
	b := bus.New()
	dashEvents := bus.Subscribe[DashboardUpdated](b, 16)
	actEvents := bus.Subscribe[RepoActivityUpdated](b, 16)
	f := &fakeRunner{}
	f.set(activityHandler(t, "pull_requests_default_branch_neovim.json"))
	rr := &restRunner{fakeRunner: f, rest: func(path string, _ map[string]string) (json.RawMessage, error) {
		if path != "search/commits" {
			return nil, fmt.Errorf("unexpected REST %s", path)
		}
		return fixture(t, "search_commits.json"), nil
	}}
	s := startStore(t, activityOptions(db, rr, b))
	if err := s.Track("neovim/neovim"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "dashboard, stats, repo activity", func() bool {
		snap := s.Snapshot()
		a := snap.Repos["neovim/neovim"].Activity
		return !snap.Dashboard.FetchedAt.IsZero() && !snap.Dashboard.Stats.FetchedAt.IsZero() &&
			!a.Stats.FetchedAt.IsZero() && !a.DefaultBranch.FetchedAt.IsZero()
	})
	snap := s.Snapshot()
	d := snap.Dashboard
	if len(d.Authored) != 5 || len(d.ReviewRequested) != 6 || len(d.RecentlyMerged) != 12 ||
		d.AuthoredTotal != 5 || d.ReviewRequestedTotal != 86 || d.RecentlyMergedTotal != 12 || d.LastError != "" {
		t.Errorf("dashboard: %d/%d/%d totals %d/%d/%d err %q", len(d.Authored), len(d.ReviewRequested),
			len(d.RecentlyMerged), d.AuthoredTotal, d.ReviewRequestedTotal, d.RecentlyMergedTotal, d.LastError)
	}
	st := d.Stats
	if st.ThisMonth.Commits != 59 || st.LastMonth.Commits != 59 || st.ThisMonth.Merged != 4 || st.LastMonth.Merged != 22 ||
		st.CommitsSource != CommitsFromSearch || st.ThisMonth.Month == "" || st.ThisMonth.Month == st.LastMonth.Month {
		t.Errorf("stats = %+v", st)
	}
	a := snap.Repos["neovim/neovim"].Activity
	if a.Stats.ThisMonth.Commits != 22 || a.Stats.LastMonth.Commits != 127 || a.Stats.ThisMonth.Merged != 4 {
		t.Errorf("repo stats = %+v", a.Stats)
	}
	if a.DefaultBranch.Branch != "master" || len(a.DefaultBranch.Failing) != 1 || a.DefaultBranch.Rollup.Failed != 1 {
		t.Errorf("default branch = %+v", a.DefaultBranch)
	}

	// Requests: viewer id filters history; searches use @me with the right types.
	calls, _ := f.snapshot()
	types := map[string]bool{}
	for _, c := range calls {
		switch c.op {
		case "RepoStats":
			if c.vars["author"] != "MDQ6VXNlcjU4MzIzMQ==" || !strings.Contains(c.vars["mergedThis"].(string), "repo:neovim/neovim") {
				t.Errorf("RepoStats vars = %v", c.vars)
			}
		case "SearchPullRequests":
			q := c.vars["q"].(string)
			if !strings.Contains(q, "@me") {
				t.Errorf("search without @me: %q", q)
			}
			types[c.vars["type"].(string)] = true
		case "ViewerStats":
			if c.vars["login"] != "octocat" {
				t.Errorf("ViewerStats login = %v", c.vars["login"])
			}
		}
	}
	if !types["ISSUE"] || !types["ISSUE_ADVANCED"] {
		t.Errorf("search types = %v", types)
	}
	rr.mu.Lock()
	if len(rr.qs) != 2 || !strings.HasPrefix(rr.qs[0], "author:@me author-date:") {
		t.Errorf("REST queries = %q", rr.qs)
	}
	rr.mu.Unlock()
	if ev := <-dashEvents.C(); ev.FetchedAt.IsZero() && false {
		t.Error("unreachable")
	}
	select {
	case <-actEvents.C():
	case <-time.After(time.Second):
		t.Error("no RepoActivityUpdated")
	}

	// An unchanged default branch on the next poll publishes no RepoActivityUpdated.
	for len(actEvents.C()) > 0 {
		<-actEvents.C()
	}
	if err := s.Refresh(context.Background(), "neovim/neovim"); err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-actEvents.C():
		t.Errorf("unchanged CI published %+v", ev)
	case <-time.After(50 * time.Millisecond):
	}

	// Restart: the snapshot comes from the cache before any request.
	s2, err := New(context.Background(), activityOptions(db, &fakeRunner{}, nil))
	if err != nil {
		t.Fatal(err)
	}
	snap2 := s2.Snapshot()
	if len(snap2.Dashboard.Authored) != 5 || snap2.Dashboard.Stats.ThisMonth.Commits != 59 ||
		snap2.Repos["neovim/neovim"].Activity.Stats.LastMonth.Commits != 127 ||
		snap2.Repos["neovim/neovim"].Activity.DefaultBranch.SHA != a.DefaultBranch.SHA {
		t.Errorf("restart snapshot = %+v", snap2.Dashboard)
	}
	if !s2.act.dashboardNext.After(time.Now()) {
		t.Errorf("restart dashboardNext = %v, want after now (cache is fresh)", s2.act.dashboardNext)
	}
}

func TestActivityCommitCountFallback(t *testing.T) {
	tests := []struct {
		name   string
		runner func(*fakeRunner) Runner
	}{
		{"runner without REST", func(f *fakeRunner) Runner { return f }},
		{"REST search rate limited", func(f *fakeRunner) Runner {
			return &restRunner{fakeRunner: f, rest: func(string, map[string]string) (json.RawMessage, error) {
				return nil, &RateLimitError{Msg: "API rate limit exceeded for search"}
			}}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeRunner{}
			f.set(activityHandler(t, "pull_requests_default_branch_neovim.json"))
			s := startStore(t, activityOptions(openTestDB(t), tt.runner(f), nil))
			_ = s.Track("neovim/neovim")
			waitFor(t, "stats", func() bool { return !s.Snapshot().Dashboard.Stats.FetchedAt.IsZero() })
			st := s.Snapshot().Dashboard.Stats
			if st.CommitsSource != CommitsFromContributions || st.ThisMonth.Commits != 35 || st.LastMonth.Commits != 143 {
				t.Errorf("stats = %+v", st)
			}
			s.mu.Lock()
			paused := !s.pauseUntil.IsZero()
			s.mu.Unlock()
			if paused {
				t.Error("a REST search rate limit paused GraphQL polling")
			}
		})
	}
}

func TestActivityDefaultBranchPagesFailures(t *testing.T) {
	f := &fakeRunner{}
	f.set(activityHandler(t, "pull_requests_default_branch_deno.json"))
	o := activityOptions(openTestDB(t), f, nil)
	o.DashboardInterval, o.StatsInterval = -1, -1
	s := startStore(t, o)
	_ = s.Track("denoland/deno")
	waitFor(t, "default branch", func() bool {
		return !s.Snapshot().Repos["denoland/deno"].Activity.DefaultBranch.FetchedAt.IsZero()
	})
	ci := s.Snapshot().Repos["denoland/deno"].Activity.DefaultBranch
	var names []string
	for _, r := range ci.Failing {
		names = append(names, r.Name)
	}
	if strings.Join(names, ",") != "ci status,test node_compat (1/3) release macos-x86_64" {
		t.Errorf("failing = %q", names)
	}
	for _, c := range func() []fakeCall { c, _ := f.snapshot(); return c }() {
		if c.op == "Checks" && c.vars["ref"] != ci.SHA {
			t.Errorf("checks paged by %v, want the head sha", c.vars["ref"])
		}
	}
}

func TestBranchPullRequestsWatchAndSearchAs(t *testing.T) {
	b := bus.New()
	events := bus.Subscribe[BranchPullRequestsUpdated](b, 16)
	f := &fakeRunner{}
	f.set(activityHandler(t, "pull_requests_default_branch_neovim.json"))
	o := testOptions(openTestDB(t), f, b)
	o.SearchAs = "mitchellh"
	o.BranchWatch = 200 * time.Millisecond
	s := startStore(t, o)

	got, err := s.BranchPullRequests(context.Background(), "Ghostty-Org/Ghostty", "osc7501")
	if err != nil {
		t.Fatal(err)
	}
	if !got.FetchedAt.IsZero() || len(got.PullRequests) != 0 || got.Slug != "ghostty-org/ghostty" {
		t.Errorf("first call = %+v, want empty never-fetched", got)
	}
	select {
	case ev := <-events.C():
		if ev.Slug != "ghostty-org/ghostty" || ev.HeadRef != "osc7501" || ev.FetchedAt.IsZero() {
			t.Errorf("event = %+v", ev)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no BranchPullRequestsUpdated")
	}
	got, _ = s.BranchPullRequests(context.Background(), "ghostty-org/ghostty", "osc7501")
	if len(got.PullRequests) != 1 || got.PullRequests[0].Number != 14560 || got.FetchedAt.IsZero() {
		t.Errorf("second call = %+v", got)
	}
	if _, err := s.BranchPullRequests(context.Background(), "ghostty-org/ghostty", " "); err == nil {
		t.Error("blank head: want error")
	}
	// The watch lapses after BranchWatch without calls.
	waitFor(t, "watch to lapse", func() bool {
		s.nudge()
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.act.branches) == 0
	})
	if n := f.count("BranchPullRequests"); n != 1 {
		t.Errorf("BranchPullRequests requests = %d, want 1 (RepoInterval is an hour)", n)
	}
}

func TestActivitySearchAsUsesLoginAndUserID(t *testing.T) {
	f := &fakeRunner{}
	f.set(activityHandler(t, "pull_requests_default_branch_neovim.json"))
	o := activityOptions(openTestDB(t), f, nil)
	o.SearchAs = "mitchellh"
	s := startStore(t, o)
	_ = s.Track("neovim/neovim")
	waitFor(t, "repo stats", func() bool {
		return !s.Snapshot().Repos["neovim/neovim"].Activity.Stats.FetchedAt.IsZero() &&
			!s.Snapshot().Dashboard.FetchedAt.IsZero()
	})
	calls, _ := f.snapshot()
	for _, c := range calls {
		switch c.op {
		case "RepoStats":
			if c.vars["author"] != "MDQ6VXNlcjEyOTk=" {
				t.Errorf("RepoStats author = %v, want mitchellh's id", c.vars["author"])
			}
		case "SearchPullRequests":
			if q := c.vars["q"].(string); strings.Contains(q, "@me") || !strings.Contains(q, "mitchellh") {
				t.Errorf("search q = %q", q)
			}
		}
	}
	if n := f.count("UserID"); n != 1 {
		t.Errorf("UserID requests = %d, want 1", n)
	}
}

func TestDashboardServerTimeoutShrinksSection(t *testing.T) {
	f := &fakeRunner{}
	base := activityHandler(t, "pull_requests_default_branch_neovim.json")
	var mu sync.Mutex
	var firsts []int
	f.set(func(op string, vars map[string]any) (json.RawMessage, error) {
		if op == "SearchPullRequests" && strings.Contains(vars["q"].(string), "review-requested:") {
			mu.Lock()
			firsts = append(firsts, vars["first"].(int))
			n := len(firsts)
			mu.Unlock()
			if n == 1 {
				return nil, fmt.Errorf("%w: HTTP 502", ErrServerTimeout)
			}
		}
		return base(op, vars)
	})
	o := activityOptions(openTestDB(t), f, nil)
	o.RepoInterval = 30 * time.Millisecond // backoff base
	o.MaxBackoff = 60 * time.Millisecond
	s := startStore(t, o)
	_ = s.Track("neovim/neovim")
	waitFor(t, "dashboard after retry", func() bool { return !s.Snapshot().Dashboard.FetchedAt.IsZero() })
	mu.Lock()
	defer mu.Unlock()
	if len(firsts) < 2 || firsts[0] != 30 || firsts[1] != 15 {
		t.Errorf("review section sizes = %v, want 30 then 15", firsts)
	}
	if s.Snapshot().Dashboard.LastError != "" {
		t.Errorf("LastError = %q after success", s.Snapshot().Dashboard.LastError)
	}
}
