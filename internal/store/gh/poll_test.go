package gh

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// poll runs one poll through the queue and returns the operations it sent.
func pollOnce(t *testing.T, s *Store, f *fakeRunner) []string {
	t.Helper()
	from := f.ncalls()
	if err := s.Refresh(context.Background(), "o/any"); err != nil {
		t.Fatalf("poll: %v", err)
	}
	return f.opsSince(from)
}

// drain empties a subscription and returns how many events it held.
func drain[T any](sub *bus.Subscription[T]) int {
	n := 0
	for {
		select {
		case <-sub.C():
			n++
		default:
			return n
		}
	}
}

// changeDrivenWorld is a tracked repository with two open PRs (one authored, one
// requesting review) and one merged.
func changeDrivenWorld() (*fakeGitHub, time.Time) {
	g := newFakeGitHub()
	t0 := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	g.setRepo("o/r", &fakeRepo{branch: "main", sha: "m1", rollup: CheckRollup{State: RollupSuccess, Total: 2, Passed: 2}})
	g.addPR(fakePR("PR_a", "o/r", 1, t0), sectionAuthored)
	review := fakePR("PR_b", "o/r", 2, t0.Add(-time.Hour))
	review.Author, review.ReviewRequests = "someone", []string{"octocat", "org/team"}
	g.addPR(review, sectionReview, sectionReviewed) // reviewed and re-requested
	merged := fakePR("PR_c", "o/r", 3, t0.Add(-2*time.Hour))
	merged.State, merged.MergedAt, merged.ReviewDecision, merged.Mergeable, merged.MergeStateStatus = PullRequestMerged, t0.Add(-2*time.Hour), "", "", ""
	g.addPR(merged, sectionMerged)
	return g, t0
}

func TestPollFetchesDetailsOnlyForWhatChanged(t *testing.T) {
	b := bus.New()
	dash := bus.Subscribe[DashboardUpdated](b, 64)
	act := bus.Subscribe[RepoActivityUpdated](b, 64)
	polled := bus.Subscribe[Polled](b, 64)
	g, t0 := changeDrivenWorld()
	f := (&fakeRunner{}).serve(g)
	s := startStore(t, testOptions(openTestDB(t), f, b))
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, f) // after it, every earlier poll has published too
	// The first full poll (possibly after an idle viewer-only one) fetched every PR's
	// detail; the one pollOnce ran (if it was another) found nothing new.
	if n := f.count("PullRequestDetails"); n != 1 {
		t.Errorf("detail requests = %d, want 1 batch", n)
	}
	calls, _ := f.snapshot()
	for _, c := range calls {
		if c.op == "PullRequestDetails" {
			if open, closed := anyStrings(c.vars["open"]), anyStrings(c.vars["closed"]); fmt.Sprint(open, closed) != "[PR_a PR_b] [PR_c]" {
				t.Errorf("detail ids = %v %v", open, closed)
			}
		}
	}
	d := s.Snapshot().Dashboard
	if a := d.Authored[0]; a.Title != "PR 1" || a.MergeStateStatus != "BLOCKED" || a.Additions != 10 || a.Partial || a.ID != "PR_a" {
		t.Errorf("authored = %+v", a)
	}
	if r := d.ReviewRequested[0]; r.Author != "someone" || fmt.Sprint(r.ReviewRequests) != "[octocat org/team]" {
		t.Errorf("review requested = %+v", r)
	}
	if len(d.Reviewed) != 0 || d.ReviewedTotal != 1 {
		t.Errorf("reviewed = %+v (total %d), want PR_b dropped: it is in review requested", d.Reviewed, d.ReviewedTotal)
	}
	if m := d.RecentlyMerged[0]; m.State != PullRequestMerged || m.MergedAt.IsZero() {
		t.Errorf("merged = %+v", m)
	}
	if ci := s.Snapshot().Repos["o/r"].Activity.DefaultBranch; ci.SHA != "m1" || ci.Rollup.Passed != 2 || ci.Branch != "main" {
		t.Errorf("default branch = %+v", ci)
	}
	drain(dash)
	drain(act)
	drain(polled)

	// Nothing changed: one request, no data events, one Polled.
	if ops := pollOnce(t, s, f); fmt.Sprint(ops) != "[Poll]" {
		t.Errorf("unchanged poll sent %v", ops)
	}
	if n := drain(dash) + drain(act); n != 0 {
		t.Errorf("unchanged poll published %d data events", n)
	}
	if n := drain(polled); n != 1 {
		t.Errorf("Polled events = %d, want 1", n)
	}

	// Only check counts moved: applied from the fingerprint, no detail request.
	g.edit("PR_a", func(p *PullRequest) { p.Checks = CheckRollup{State: RollupSuccess, Total: 4, Passed: 4} })
	if ops := pollOnce(t, s, f); fmt.Sprint(ops) != "[Poll]" {
		t.Errorf("count-only change sent %v", ops)
	}
	if a := s.Snapshot().Dashboard.Authored[0]; a.Checks.Total != 4 || a.Title != "PR 1" {
		t.Errorf("authored after count change = %+v", a)
	}
	if n := drain(dash); n != 1 {
		t.Errorf("DashboardUpdated = %d, want 1", n)
	}

	// The rollup state changed (mergeStateStatus depends on it): refetch that PR only.
	g.edit("PR_a", func(p *PullRequest) {
		p.Checks = CheckRollup{State: RollupFailure, Total: 4, Passed: 3, Failed: 1}
		p.MergeStateStatus = "UNSTABLE"
	})
	from := f.ncalls()
	pollOnce(t, s, f)
	calls, _ = f.snapshot()
	for _, c := range calls[from:] {
		if c.op == "PullRequestDetails" && fmt.Sprint(anyStrings(c.vars["open"]), anyStrings(c.vars["closed"])) != "[PR_a] []" {
			t.Errorf("rollup change refetched %v %v", c.vars["open"], c.vars["closed"])
		}
	}
	if a := s.Snapshot().Dashboard.Authored[0]; a.MergeStateStatus != "UNSTABLE" || a.Checks.Failed != 1 {
		t.Errorf("authored after rollup change = %+v", a)
	}

	// updatedAt moved (a push, a comment): refetch that PR only.
	g.edit("PR_b", func(p *PullRequest) { p.UpdatedAt = t0.Add(time.Minute); p.Title = "renamed"; p.Comments = 3 })
	from = f.ncalls()
	pollOnce(t, s, f)
	if ops := f.opsSince(from); fmt.Sprint(ops) != "[Poll PullRequestDetails]" {
		t.Errorf("updatedAt change sent %v", ops)
	}
	if r := s.Snapshot().Dashboard.ReviewRequested[0]; r.Title != "renamed" || r.Comments != 3 {
		t.Errorf("review requested after edit = %+v", r)
	}

	// Default branch head moved: activity event; unchanged next time: none.
	drain(act)
	g.editRepo("o/r", func(r *fakeRepo) { r.sha = "m2" })
	pollOnce(t, s, f)
	if n := drain(act); n != 1 {
		t.Errorf("RepoActivityUpdated after head change = %d, want 1", n)
	}
	pollOnce(t, s, f)
	if n := drain(act); n != 0 {
		t.Errorf("RepoActivityUpdated with nothing changed = %d", n)
	}
}

func TestPollDefaultBranchFailingChecks(t *testing.T) {
	g := newFakeGitHub()
	failing := []CheckRun{{Name: "linux", URL: "u1", Conclusion: ConclusionFailure}}
	g.setRepo("o/r", &fakeRepo{branch: "main", sha: "m1", rollup: CheckRollup{State: RollupFailure, Total: 3, Passed: 2, Failed: 1}, failing: failing})
	g.setRepo("o/ok", &fakeRepo{branch: "main", sha: "k1", rollup: CheckRollup{State: RollupSuccess, Total: 1, Passed: 1}})
	f := (&fakeRunner{}).serve(g)
	opts := testOptions(openTestDB(t), f, nil)
	s := startStore(t, opts)
	for _, slug := range []string{"o/r", "o/ok"} {
		if err := s.Track(slug); err != nil {
			t.Fatal(err)
		}
	}
	waitFor(t, "failing checks", func() bool { return len(s.Snapshot().Repos["o/r"].Activity.DefaultBranch.Failing) == 1 })
	if n := f.count("DefaultBranchChecks"); n != 1 {
		t.Errorf("DefaultBranchChecks = %d, want 1 (only the failing repository)", n)
	}
	calls, _ := f.snapshot()
	for _, c := range calls {
		if c.op == "DefaultBranchChecks" && (c.vars["r0n"] != "r" || c.vars["r0s"] != "m1" || c.vars["r1n"] != nil) {
			t.Errorf("DefaultBranchChecks vars = %v", c.vars)
		}
	}

	// Same head, same failure count: the list is kept, nothing fetched.
	if ops := pollOnce(t, s, f); fmt.Sprint(ops) != "[Poll]" {
		t.Errorf("unchanged sent %v", ops)
	}
	// Another failure on the same head: refetched.
	g.editRepo("o/r", func(r *fakeRepo) {
		r.rollup = CheckRollup{State: RollupFailure, Total: 3, Passed: 1, Failed: 2}
		r.failing = append(r.failing, CheckRun{Name: "mac", URL: "u2", Conclusion: ConclusionFailure})
	})
	if ops := pollOnce(t, s, f); fmt.Sprint(ops) != "[Poll DefaultBranchChecks]" {
		t.Errorf("failure count change sent %v", ops)
	}
	if ci := s.Snapshot().Repos["o/r"].Activity.DefaultBranch; len(ci.Failing) != 2 || ci.Failing[0].Name != "linux" {
		t.Errorf("failing = %+v", ci.Failing)
	}
	// Fixed on a new head: cleared without a request.
	g.editRepo("o/r", func(r *fakeRepo) {
		r.sha, r.rollup, r.failing = "m2", CheckRollup{State: RollupSuccess, Total: 3, Passed: 3}, nil
	})
	if ops := pollOnce(t, s, f); fmt.Sprint(ops) != "[Poll]" {
		t.Errorf("fixed head sent %v", ops)
	}
	if ci := s.Snapshot().Repos["o/r"].Activity.DefaultBranch; len(ci.Failing) != 0 || ci.SHA != "m2" {
		t.Errorf("after fix = %+v", ci)
	}
}

func TestPollPartialResults(t *testing.T) {
	b := bus.New()
	act := bus.Subscribe[RepoActivityUpdated](b, 64)
	g := newFakeGitHub()
	g.setRepo("o/r", &fakeRepo{branch: "main", sha: "m1"})
	f := (&fakeRunner{}).serve(g)
	s := startStore(t, testOptions(openTestDB(t), f, b))
	for _, slug := range []string{"o/r", "o/gone"} {
		if err := s.Track(slug); err != nil {
			t.Fatal(err)
		}
	}
	pollOnce(t, s, f)
	snap := s.Snapshot()
	if e := snap.Repos["o/gone"].Activity.DefaultBranch.LastError; !strings.Contains(e, "Could not resolve") {
		t.Errorf("missing repo error = %q", e)
	}
	if snap.Poll.LastError != "" || snap.Viewer.LastError != "" || snap.Repos["o/r"].Activity.DefaultBranch.LastError != "" {
		t.Errorf("one missing repository failed more: %+v", snap.Poll)
	}
	// The error is announced once, not on every poll.
	drain(act)
	pollOnce(t, s, f)
	if n := drain(act); n != 0 {
		t.Errorf("repeated error published %d events", n)
	}
}

func TestPollBranchWatch(t *testing.T) {
	b := bus.New()
	events := bus.Subscribe[BranchPullRequestsUpdated](b, 64)
	g := newFakeGitHub()
	t0 := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	mine := fakePR("PR_mine", "o/r", 7, t0)
	mine.HeadRef = "feat"
	fork := fakePR("PR_fork", "o/r", 8, t0)
	fork.HeadRef, fork.IsCrossRepository = "feat", true
	theirs := fakePR("PR_theirs", "o/r", 9, t0)
	theirs.HeadRef, theirs.Author = "feat", "someone"
	for _, p := range []PullRequest{mine, fork, theirs} {
		g.addPR(p)
	}
	g.setRepo("o/r", &fakeRepo{branch: "main", sha: "m1"})
	g.setBranch("o/r", "feat", "PR_mine", "PR_fork", "PR_theirs")
	f := (&fakeRunner{}).serve(g)
	opts := testOptions(openTestDB(t), f, b)
	var clock sync.Mutex
	var offset time.Duration
	opts.Now = func() time.Time { clock.Lock(); defer clock.Unlock(); return time.Now().Add(offset) }
	s := startStore(t, opts)
	ctx := context.Background()

	// A first call returns nothing yet and puts the branch into the next poll (an
	// untracked repository is polled for the branch only).
	first, err := s.BranchPullRequests(ctx, "O/R", "feat")
	if err != nil || len(first.PullRequests) != 0 || !first.FetchedAt.IsZero() || first.Slug != "o/r" {
		t.Fatalf("first = %+v, %v", first, err)
	}
	ev := <-events.C()
	if ev.Slug != "o/r" || ev.HeadRef != "feat" {
		t.Errorf("event = %+v", ev)
	}
	got, _ := s.BranchPullRequests(ctx, "o/r", "feat")
	if len(got.PullRequests) != 1 || got.PullRequests[0].Number != 7 || got.PullRequests[0].Title != "PR 7" {
		t.Errorf("branch PRs = %+v, want only the viewer's own non-fork PR with details", got.PullRequests)
	}
	calls, _ := f.snapshot()
	last := calls[len(calls)-1]
	for _, c := range calls {
		if c.op == "Poll" {
			last = c
		}
	}
	if last.vars["r0b0"] != "feat" || last.vars["q_authored"] != nil {
		t.Errorf("poll vars = %v, want the branch and no dashboards (nothing tracked)", last.vars)
	}

	// Unchanged: no event. Changed: one.
	pollOnce(t, s, f)
	if n := drain(events); n != 0 {
		t.Errorf("unchanged branch published %d events", n)
	}
	g.edit("PR_mine", func(p *PullRequest) { p.UpdatedAt = t0.Add(time.Minute); p.State = PullRequestMerged })
	pollOnce(t, s, f)
	if n := drain(events); n != 1 {
		t.Errorf("changed branch published %d events", n)
	}

	// After BranchWatch without calls, the branch leaves the poll.
	clock.Lock()
	offset = opts.BranchWatch + DefaultBranchWatch + time.Minute
	clock.Unlock()
	from := f.ncalls()
	pollOnce(t, s, f)
	calls, _ = f.snapshot()
	for _, c := range calls[from:] {
		if c.op == "Poll" && c.vars["r0b0"] != nil {
			t.Errorf("expired branch still polled: %v", c.vars)
		}
	}
}

func TestPollDetailBatchesAndServerTimeout(t *testing.T) {
	g := newFakeGitHub()
	t0 := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	for i := range 5 {
		g.addPR(fakePR(fmt.Sprintf("PR_%d", i), "o/r", i+1, t0), sectionAuthored)
	}
	g.setRepo("o/r", &fakeRepo{branch: "main", sha: "m1"})
	g.failNext("PullRequestDetails", fmt.Errorf("%w: HTTP 502", ErrServerTimeout))
	f := (&fakeRunner{}).serve(g)
	opts := testOptions(openTestDB(t), f, nil)
	opts.DetailBatch = 4
	s := startStore(t, opts)
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "details", func() bool {
		d := s.Snapshot().Dashboard
		return len(d.Authored) == 5 && !slices.ContainsFunc(d.Authored, func(p PullRequest) bool { return p.Partial })
	})
	var sizes []int
	calls, _ := f.snapshot()
	for _, c := range calls {
		if c.op == "PullRequestDetails" {
			sizes = append(sizes, len(anyStrings(c.vars["open"])))
		}
	}
	// 4 timed out, then batches of 2 (sticky).
	if fmt.Sprint(sizes) != "[4 2 2 1]" {
		t.Errorf("detail batch sizes = %v, want [4 2 2 1]", sizes)
	}

	// A poll timeout halves the searches and retries at once.
	g.failNext("Poll", fmt.Errorf("%w: HTTP 504", ErrServerTimeout))
	if err := s.Refresh(context.Background(), "o/r"); err == nil {
		t.Error("timed-out poll: want its error")
	}
	waitFor(t, "retry", func() bool {
		calls, _ := f.snapshot()
		c := calls[len(calls)-1]
		return c.op == "Poll" && strings.Contains(fmt.Sprint(c.vars), "q_authored")
	})
	if s.searchFirst[sectionAuthored] != searchFirstOpen/2 {
		t.Errorf("search sizes = %v", s.searchFirst)
	}
}

func TestPollDetailFailureLeavesPlaceholders(t *testing.T) {
	g := newFakeGitHub()
	t0 := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	g.addPR(fakePR("PR_a", "o/r", 1, t0), sectionAuthored)
	g.setRepo("o/r", &fakeRepo{branch: "main", sha: "m1"})
	g.failNext("PullRequestDetails", fmt.Errorf("github graphql: boom"))
	f := (&fakeRunner{}).serve(g)
	s := startStore(t, testOptions(openTestDB(t), f, nil))
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "poll", func() bool { return len(s.Snapshot().Dashboard.Authored) == 1 })
	snap := s.Snapshot()
	if p := snap.Dashboard.Authored[0]; !p.Partial || p.Number != 1 || p.URL != "https://github.com/o/r/pull/1" || p.Checks.Passed != 3 {
		t.Errorf("placeholder = %+v", p)
	}
	if !strings.Contains(snap.Poll.LastError, "boom") {
		t.Errorf("poll error = %q", snap.Poll.LastError)
	}
	// The next poll retries the detail.
	pollOnce(t, s, f)
	if p := s.Snapshot().Dashboard.Authored[0]; p.Partial || p.Title != "PR 1" || s.Snapshot().Poll.LastError != "" {
		t.Errorf("after retry = %+v", p)
	}
}

func TestPollMergeableRecheck(t *testing.T) {
	g := newFakeGitHub()
	t0 := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	p := fakePR("PR_a", "o/r", 1, t0)
	p.Mergeable, p.MergeStateStatus = MergeableUnknown, "UNKNOWN"
	g.addPR(p, sectionAuthored)
	g.setRepo("o/r", &fakeRepo{branch: "main", sha: "m1"})
	f := (&fakeRunner{}).serve(g)
	s := startStore(t, testOptions(openTestDB(t), f, nil))
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "poll", func() bool { return len(s.Snapshot().Dashboard.Authored) == 1 })
	// GitHub finishes computing without bumping updatedAt; the recheck picks it up.
	g.edit("PR_a", func(p *PullRequest) { p.Mergeable, p.MergeStateStatus = MergeableMergeable, "CLEAN" })
	if ops := pollOnce(t, s, f); fmt.Sprint(ops) != "[Poll PullRequestDetails]" {
		t.Errorf("recheck sent %v", ops)
	}
	if a := s.Snapshot().Dashboard.Authored[0]; a.MergeStateStatus != "CLEAN" {
		t.Errorf("after recheck = %+v", a)
	}
	if ops := pollOnce(t, s, f); fmt.Sprint(ops) != "[Poll]" {
		t.Errorf("settled PR refetched: %v", ops)
	}
}

func TestPollDashboardsDisabled(t *testing.T) {
	b := bus.New()
	dash := bus.Subscribe[DashboardUpdated](b, 64)
	g, _ := changeDrivenWorld()
	f := (&fakeRunner{}).serve(g)
	opts := testOptions(openTestDB(t), f, b)
	var mu sync.Mutex
	enabled := true
	opts.Config = func() Config { mu.Lock(); defer mu.Unlock(); return Config{Dashboards: enabled} }
	s := startStore(t, opts)
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, f)
	if len(s.Snapshot().Dashboard.Authored) != 1 {
		t.Fatalf("dashboard = %+v", s.Snapshot().Dashboard)
	}
	drain(dash)
	mu.Lock()
	enabled = false
	mu.Unlock()
	from := f.ncalls()
	pollOnce(t, s, f)
	calls, _ := f.snapshot()
	if c := calls[from]; c.vars["q_authored"] != nil || c.vars["r0o"] != "o" {
		t.Errorf("poll with dashboards off = %v", c.vars)
	}
	d := s.Snapshot().Dashboard
	if !d.Disabled || len(d.Authored) != 0 || len(d.RecentlyMerged) != 0 {
		t.Errorf("dashboard = %+v, want disabled and empty", d)
	}
	if n := drain(dash); n != 1 {
		t.Errorf("DashboardUpdated = %d, want 1", n)
	}
}

func TestPollCacheRestart(t *testing.T) {
	db := openTestDB(t)
	g, _ := changeDrivenWorld()
	g.setBranch("o/r", "branch-1", "PR_a")
	f := (&fakeRunner{}).serve(g)
	s := startStore(t, testOptions(db, f, nil))
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BranchPullRequests(context.Background(), "o/r", "branch-1"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "poll", func() bool {
		st, _ := s.branches.get(branchKey{"o/r", "branch-1"})
		return len(s.Snapshot().Dashboard.Authored) == 1 && len(st.PullRequests) == 1
	})

	// Restart: the snapshot comes from the cache before any request, the first poll
	// waits out the interval, and an immediate poll fetches no details.
	f2 := (&fakeRunner{}).serve(g)
	opts := testOptions(db, f2, nil)
	s2, err := New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	snap := s2.Snapshot()
	if len(snap.Dashboard.Authored) != 1 || snap.Dashboard.Authored[0].Title != "PR 1" ||
		snap.Repos["o/r"].Activity.DefaultBranch.SHA != "m1" || snap.Viewer.Viewer == nil || snap.Poll.FetchedAt.IsZero() {
		t.Errorf("restart snapshot = %+v", snap)
	}
	if !s2.pollNext.After(time.Now()) {
		t.Errorf("restart pollNext = %v, want after now (cache is fresh)", s2.pollNext)
	}
	bp, _ := s2.BranchPullRequests(context.Background(), "o/r", "branch-1")
	if len(bp.PullRequests) != 1 || bp.FetchedAt.IsZero() {
		t.Errorf("cached branch = %+v", bp)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = s2.Run(ctx) }()
	defer func() { cancel(); <-done }()
	if err := s2.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	if err := s2.Refresh(context.Background(), "o/r"); err != nil {
		t.Fatal(err)
	}
	if ops := f2.opsSince(0); fmt.Sprint(ops) != "[Poll]" {
		t.Errorf("first poll after restart sent %v, want no details", ops)
	}
}

func TestPollStats(t *testing.T) {
	b := bus.New()
	act := bus.Subscribe[RepoActivityUpdated](b, 64)
	g := newFakeGitHub()
	g.setRepo("o/r", &fakeRepo{branch: "main", sha: "m1", history: [2]int{22, 127}})
	g.setRepo("o/other", &fakeRepo{branch: "main", sha: "k1", history: [2]int{1, 0}})
	now := time.Now()
	this, last := monthWindows(now)
	g.mergedThis, g.mergedLast, g.contribThis, g.contribLast = 4, 22, 50, 60
	g.merged = []mergedItem{
		{Repo: "o/r", MergedAt: this.Start.Add(time.Hour)},
		{Repo: "o/r", MergedAt: last.Start.Add(time.Hour)},
		{Repo: "o/r", MergedAt: last.Start.Add(2 * time.Hour)},
		{Repo: "x/elsewhere", MergedAt: this.Start.Add(time.Hour)},
	}
	f := (&fakeRunner{}).serve(g)
	rest := &restRunner{fakeRunner: f, rest: func(path string, params map[string]string) (json.RawMessage, error) {
		if path != "search/commits" {
			return nil, fmt.Errorf("unexpected REST %s", path)
		}
		if strings.Contains(params["q"], this.searchRange()) {
			return json.RawMessage(`{"total_count": 59}`), nil
		}
		return json.RawMessage(`{"total_count": 61}`), nil
	}}
	opts := testOptions(openTestDB(t), rest, b)
	opts.StatsInterval = time.Hour
	s := startStore(t, opts)
	for _, slug := range []string{"o/r", "o/other"} {
		if err := s.Track(slug); err != nil {
			t.Fatal(err)
		}
	}
	// The first poll learns the viewer id; stats (history by author id) follow.
	waitFor(t, "stats", func() bool { return !s.Snapshot().Repos["o/r"].Activity.Stats.FetchedAt.IsZero() })
	snap := s.Snapshot()
	st := snap.Dashboard.Stats
	if st.ThisMonth.Merged != 4 || st.LastMonth.Merged != 22 || st.ThisMonth.Commits != 59 || st.LastMonth.Commits != 61 ||
		st.CommitsSource != CommitsFromSearch || st.ThisMonth.Month != this.Label || st.LastMonth.Month != last.Label {
		t.Errorf("global stats = %+v", st)
	}
	rs := snap.Repos["o/r"].Activity.Stats
	if rs.ThisMonth.Commits != 22 || rs.LastMonth.Commits != 127 || rs.ThisMonth.Merged != 1 || rs.LastMonth.Merged != 2 {
		t.Errorf("repo stats = %+v", rs)
	}
	if os := snap.Repos["o/other"].Activity.Stats; os.ThisMonth.Commits != 1 || os.ThisMonth.Merged != 0 {
		t.Errorf("other repo stats = %+v", os)
	}
	rest.mu.Lock()
	if len(rest.qs) != 2 || !strings.HasPrefix(rest.qs[0], "author:@me author-date:") {
		t.Errorf("REST queries = %q", rest.qs)
	}
	rest.mu.Unlock()
	calls, _ := f.snapshot()
	for _, c := range calls {
		if c.op == "Poll" && c.vars["author"] != nil && c.vars["author"] != "MDQ6VXNlcjU4MzIzMQ==" {
			t.Errorf("history author = %v", c.vars["author"])
		}
	}

	// Not due again within the interval: the next poll has no stats.
	pollOnce(t, s, f) // settles any poll still running
	drain(act)
	from := f.ncalls()
	pollOnce(t, s, f)
	calls, _ = f.snapshot()
	if c := calls[from]; c.vars["mergedThis"] != nil || c.vars["author"] != nil {
		t.Errorf("stats repeated within the interval: %v", c.vars)
	}
	if n := drain(act); n != 0 {
		t.Errorf("unchanged poll published %d activity events", n)
	}
}

func TestPollSearchAs(t *testing.T) {
	g := newFakeGitHub()
	t0 := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	other := fakePR("PR_x", "o/r", 5, t0)
	other.Author = "mitchellh"
	g.addPR(other, sectionAuthored)
	g.setRepo("o/r", &fakeRepo{branch: "main", sha: "m1"})
	g.setBranch("o/r", other.HeadRef, "PR_x")
	f := (&fakeRunner{}).serve(g)
	opts := testOptions(openTestDB(t), f, nil)
	opts.SearchAs = "mitchellh"
	s := startStore(t, opts)
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BranchPullRequests(context.Background(), "o/r", other.HeadRef); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "branch", func() bool {
		st, _ := s.branches.get(branchKey{"o/r", other.HeadRef})
		return len(st.PullRequests) == 1
	})
	calls, _ := f.snapshot()
	for _, c := range calls {
		if c.op != "Poll" {
			continue
		}
		if q, ok := c.vars["q_authored"].(string); ok && !strings.Contains(q, "author:mitchellh") {
			t.Errorf("search = %q", q)
		}
		if c.vars["searchAs"] != nil && c.vars["searchAs"] != "mitchellh" {
			t.Errorf("searchAs = %v", c.vars["searchAs"])
		}
	}
}

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
