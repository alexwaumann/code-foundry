package gh

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func openBenchDB(b *testing.B) *sql.DB {
	b.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(b.TempDir(), "gh.sqlite")+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(wal)")
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = db.Close() })
	if err := Migrate(context.Background(), db); err != nil {
		b.Fatal(err)
	}
	return db
}

type countingDB struct {
	DB
	queries atomic.Int64
}

func (c *countingDB) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	c.queries.Add(1)
	return c.DB.QueryRowContext(ctx, query, args...)
}

func (c *countingDB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	c.queries.Add(1)
	return c.DB.QueryContext(ctx, query, args...)
}

func sampleDashboard() Dashboard {
	t0 := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	makeList := func(prefix string, n int, state PullRequestState) []PullRequest {
		out := make([]PullRequest, n)
		for i := range n {
			p := fakePR(fmt.Sprintf("%s_%d", prefix, i), "o/r", i+1, t0.Add(time.Duration(i)*time.Minute))
			p.State = state
			p.LatestReviews = []Review{
				{Author: "alice", State: "APPROVED", SubmittedAt: t0, CommitSHA: p.HeadSHA},
				{Author: "bob", State: "COMMENTED", SubmittedAt: t0.Add(time.Minute), CommitSHA: p.HeadSHA},
			}
			p.ReviewRequests = []string{"carol", "org/core"}
			p.ReviewCommits = true
			if state == PullRequestMerged {
				p.MergedAt = t0.Add(time.Hour)
			}
			out[i] = p
		}
		return out
	}
	return Dashboard{
		Authored:             makeList("PR_a", 20, PullRequestOpen),
		ReviewRequested:      makeList("PR_r", 15, PullRequestOpen),
		Reviewed:             makeList("PR_v", 15, PullRequestOpen),
		RecentlyMerged:       makeList("PR_m", 20, PullRequestMerged),
		AuthoredTotal:        20,
		ReviewRequestedTotal: 15,
		ReviewedTotal:        15,
		RecentlyMergedTotal:  20,
		ReviewedListed:       15,
		FetchedAt:            t0,
		Stats: MonthlyStats{
			Months: []MonthCount{
				{Month: "2026-11", Commits: 42, Merged: 12, Source: CommitsFromSearch},
				{Month: "2026-10", Commits: 58, Merged: 19, Source: CommitsFromSearch},
				{Month: "2026-09", Commits: 31, Merged: 8, Source: CommitsFromSearch},
				{Month: "2026-08", Commits: 47, Merged: 14, Source: CommitsFromSearch},
				{Month: "2026-07", Commits: 29, Merged: 9, Source: CommitsFromSearch},
				{Month: "2026-06", Commits: 36, Merged: 11, Source: CommitsFromSearch},
			},
			CommitsSource: CommitsFromSearch,
			FetchedAt:     t0,
			ClosedAt:      t0.Add(-time.Hour),
		},
	}
}

func BenchmarkSameDashboard(b *testing.B) {
	a := sampleDashboard()
	c := sampleDashboard()
	c.FetchedAt = c.FetchedAt.Add(time.Minute)
	c.Stats.FetchedAt = c.Stats.FetchedAt.Add(time.Minute)
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if !sameDashboard(a, c) {
			b.Fatal("expected equal")
		}
	}
}

func BenchmarkPullRequestCacheHit(b *testing.B) {
	g, _ := changeDrivenWorld()
	f := &fakeRunner{}
	f.setDoc(answerPullRequest(g))
	db := &countingDB{DB: openBenchDB(b)}
	opts := testOptions(db, f, nil)
	opts.DetailTTL = time.Hour
	s, err := New(context.Background(), opts)
	if err != nil {
		b.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = s.Run(ctx) }()
	defer func() { cancel(); <-done }()
	if _, err := s.PullRequest(ctx, "o/r", 1); err != nil {
		b.Fatal(err)
	}
	db.queries.Store(0)
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if _, err := s.PullRequest(ctx, "o/r", 1); err != nil {
			b.Fatal(err)
		}
	}
	b.StopTimer()
	b.ReportMetric(float64(db.queries.Load())/float64(b.N), "sqlite_queries/op")
}

func TestPerfMeasurements(t *testing.T) {
	ctx := context.Background()

	t.Run("sqlite_hydrated_unchanged_pr", func(t *testing.T) {
		g, _ := changeDrivenWorld()
		g.setBody("PR_a", "v1")
		db := openTestDB(t)
		clk := &testClock{}

		opts1 := testOptions(db, (&fakeRunner{}).serve(g), nil)
		opts1.Now = clk.now
		s1 := startStore(t, opts1)
		if err := s1.Track("o/r"); err != nil {
			t.Fatal(err)
		}
		pollOnce(t, s1, opts1.Runner.(*fakeRunner))
		if _, err := s1.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}

		// Simulate restart: new Store on the same SQLite DB, live poll confirms unchanged.
		clk.advance(5 * time.Second)
		f2 := (&fakeRunner{}).serve(g)
		opts2 := testOptions(db, f2, nil)
		opts2.Now = clk.now
		s2 := startStore(t, opts2)
		if err := s2.Track("o/r"); err != nil {
			t.Fatal(err)
		}
		pollOnce(t, s2, f2)
		d, err := s2.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		settleWorker(t, s2)
		t.Logf("METRIC sqlite_hydrated_unchanged: graphql_PullRequestFull=%d refreshing=%v", f2.count("PullRequestFull"), d.Refreshing)
	})

	t.Run("pending_ci_5_ticks", func(t *testing.T) {
		g, _ := changeDrivenWorld()
		g.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupPending, Total: 12, Passed: 1, Pending: 11}
		})
		f := (&fakeRunner{}).serve(g)
		clk := &testClock{}
		opts := testOptions(openTestDB(t), f, nil)
		opts.Now = clk.now
		s := startStore(t, opts)
		if err := s.Track("o/r"); err != nil {
			t.Fatal(err)
		}
		pollOnce(t, s, f)
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		before := f.count("PullRequestFull")
		var last FullPullRequest
		for i := 2; i <= 6; i++ {
			clk.advance(30 * time.Second)
			g.edit("PR_a", func(p *PullRequest) {
				p.Checks = CheckRollup{State: RollupPending, Total: 12, Passed: i, Pending: 12 - i}
			})
			pollOnce(t, s, f)
			var err error
			last, err = s.FullPullRequest(ctx, "o/r", 1, false)
			if err != nil {
				t.Fatal(err)
			}
			settleWorker(t, s)
		}
		t.Logf("METRIC pending_ci_5_ticks: graphql_PullRequestFull=%d graphql_Checks=%d final_passed=%d final_pending=%d",
			f.count("PullRequestFull")-before, f.count("Checks"), last.PullRequest.Checks.Passed, last.PullRequest.Checks.Pending)
	})

	t.Run("get_pull_request_cache_hit", func(t *testing.T) {
		g, _ := changeDrivenWorld()
		f := &fakeRunner{}
		f.setDoc(answerPullRequest(g))
		db := &countingDB{DB: openTestDB(t)}
		opts := testOptions(db, f, nil)
		opts.DetailTTL = time.Hour
		s := startStore(t, opts)
		if _, err := s.PullRequest(ctx, "o/r", 1); err != nil {
			t.Fatal(err)
		}
		db.queries.Store(0)
		const n = 200
		start := time.Now()
		for range n {
			if _, err := s.PullRequest(ctx, "o/r", 1); err != nil {
				t.Fatal(err)
			}
		}
		dur := time.Since(start)
		t.Logf("METRIC get_pull_request_cache_hit: calls=%d sqlite_queries=%d avg=%v", n, db.queries.Load(), dur/n)
	})

	t.Run("reviewer_candidates_keystrokes", func(t *testing.T) {
		g, _ := changeDrivenWorld()
		g.detail.assignable = []ReviewerCandidate{
			{ID: "U1", Login: "jdoe", Name: "Doe, Jane"},
			{ID: "U2", Login: "janet", Name: "Janet Smith"},
			{ID: "U3", Login: "doe-j", Name: "John Doe"},
			{ID: "U4", Login: "jane-doe-bot", Name: ""},
			{ID: "U5", Login: "alice", Name: "Alice Wonder"},
			{ID: "U6", Login: "bob", Name: "Bob Builder"},
		}
		f := (&fakeRunner{}).serve(g)
		opts := testOptions(openTestDB(t), f, nil)
		s := startStore(t, opts)
		// Initial picker open
		if _, err := s.ReviewerCandidates(ctx, "o/r", 1, ""); err != nil {
			t.Fatal(err)
		}
		before := f.count("ReviewerCandidates")
		keystrokes := []string{"j", "ja", "jan", "jane", "jane d", "jane doe"}
		start := time.Now()
		for _, q := range keystrokes {
			if _, err := s.ReviewerCandidates(ctx, "o/r", 1, q); err != nil {
				t.Fatal(err)
			}
		}
		dur := time.Since(start)
		t.Logf("METRIC reviewer_candidates_6_keystrokes: graphql_calls=%d total=%v avg=%v",
			f.count("ReviewerCandidates")-before, dur, dur/time.Duration(len(keystrokes)))
	})

	t.Run("background_5_poll_cycles_unwatched", func(t *testing.T) {
		g, _ := projectsWorld()
		f := (&fakeRunner{}).serve(g)
		opts := testOptions(openTestDB(t), f, nil)
		s := startStore(t, opts)
		for _, slug := range []string{"o/r", "o/s"} {
			if err := s.Track(slug); err != nil {
				t.Fatal(err)
			}
		}
		// Warm up initial poll so steady-state details are cached.
		pollOnce(t, s, f)
		from := f.ncalls()
		for range 5 {
			pollOnce(t, s, f)
		}
		calls, _ := f.snapshot()
		total := len(calls) - from
		pollCount := f.countSince(from, "Poll")
		projectsCount := f.countSince(from, "PollProjects")
		t.Logf("METRIC background_5_poll_cycles_unwatched: total_graphql=%d poll=%d poll_projects=%d", total, pollCount, projectsCount)
	})
}
