package gh

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
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

	t.Run("mutations_warm_panel_and_read", func(t *testing.T) {
		head1 := fmt.Sprintf("%040d", 1)
		nonPollCalls := func(w *fakeWriter, from int) (total, fullFetches int) {
			calls, _ := w.snapshot()
			for _, c := range calls[from:] {
				if c.op == "Poll" || c.op == "PullRequestDetails" || c.op == "DefaultBranchChecks" || c.op == "PollProjects" {
					continue
				}
				total++
				if c.op == "PullRequestFull" {
					fullFetches++
				}
			}
			return total, fullFetches
		}
		measure := func(name string, prNum int, setup func(*fakeGitHub), mutate func(*Store) error) {
			t.Helper()
			g, w, s, _, _ := mergeWorld(t)
			g.edit("PR_1", func(p *PullRequest) { p.Author = "kim" })
			g.setBody("PR_1", "- [ ] task one\n")
			if setup != nil {
				setup(g)
			}
			if _, err := s.FullPullRequest(ctx, "o/r", prNum, false); err != nil {
				t.Fatal(err)
			}
			from := w.ncalls()
			if err := mutate(s); err != nil {
				t.Fatalf("%s mutate: %v", name, err)
			}
			if _, err := s.FullPullRequest(ctx, "o/r", prNum, false); err != nil {
				t.Fatalf("%s post-read: %v", name, err)
			}
			settleWorker(t, s)
			totalGQL, fullFetches := nonPollCalls(w, from)
			t.Logf("METRIC mutation_warm_%s: graphql_requests=%d pull_request_full=%d", name, totalGQL, fullFetches)
		}
		measure("add_comment", 1, nil, func(s *Store) error {
			_, err := s.AddPullRequestComment(ctx, "o/r", 1, "looks good")
			return err
		})
		measure("submit_review", 1, nil, func(s *Store) error {
			_, err := s.SubmitPullRequestReview(ctx, "o/r", 1, ReviewSubmission{Event: ReviewEventApprove, Body: "lgtm"})
			return err
		})
		measure("set_draft", 1, nil, func(s *Store) error {
			_, err := s.SetPullRequestDraft(ctx, "o/r", 1, true)
			return err
		})
		measure("set_closed", 1, nil, func(s *Store) error {
			_, err := s.SetPullRequestClosed(ctx, "o/r", 1, true)
			return err
		})
		measure("set_auto_merge", 1, nil, func(s *Store) error {
			_, err := s.SetPullRequestAutoMerge(ctx, "o/r", 1, AutoMergeChange{Enabled: true, Method: MergeSquash, ExpectedHeadSHA: head1})
			return err
		})
		measure("merge", 1, nil, func(s *Store) error {
			_, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash, ExpectedHeadSHA: head1})
			return err
		})
		measure("set_checkbox", 1, nil, func(s *Store) error {
			_, err := s.SetPullRequestCheckbox(ctx, "o/r", 1, CheckboxChange{Index: 0, Text: "task one", Checked: true})
			return err
		})
	})

	t.Run("mutations_cold_detail_after_poll", func(t *testing.T) {
		head1 := fmt.Sprintf("%040d", 1)
		nonPollCalls := func(w *fakeWriter, from int) (total, fullFetches int) {
			calls, _ := w.snapshot()
			for _, c := range calls[from:] {
				if c.op == "Poll" || c.op == "PullRequestDetails" || c.op == "DefaultBranchChecks" || c.op == "PollProjects" {
					continue
				}
				total++
				if c.op == "PullRequestFull" {
					fullFetches++
				}
			}
			return total, fullFetches
		}
		measure := func(name string, mutate func(*Store) error) {
			t.Helper()
			g, w, s, _, _ := mergeWorld(t)
			g.edit("PR_1", func(p *PullRequest) { p.Author = "kim" })
			if err := s.Track("o/r"); err != nil {
				t.Fatal(err)
			}
			pollOnce(t, s, w.fakeRunner)
			from := w.ncalls()
			if err := mutate(s); err != nil {
				t.Fatalf("%s mutate: %v", name, err)
			}
			totalGQL, fullFetches := nonPollCalls(w, from)
			t.Logf("METRIC mutation_cold_polled_%s: graphql_requests=%d pull_request_full=%d", name, totalGQL, fullFetches)
		}
		measure("add_comment", func(s *Store) error {
			_, err := s.AddPullRequestComment(ctx, "o/r", 1, "looks good")
			return err
		})
		measure("submit_review", func(s *Store) error {
			_, err := s.SubmitPullRequestReview(ctx, "o/r", 1, ReviewSubmission{Event: ReviewEventApprove, Body: "lgtm"})
			return err
		})
		measure("set_draft", func(s *Store) error {
			_, err := s.SetPullRequestDraft(ctx, "o/r", 1, true)
			return err
		})
		measure("set_closed", func(s *Store) error {
			_, err := s.SetPullRequestClosed(ctx, "o/r", 1, true)
			return err
		})
		measure("set_auto_merge", func(s *Store) error {
			_, err := s.SetPullRequestAutoMerge(ctx, "o/r", 1, AutoMergeChange{Enabled: true, Method: MergeSquash, ExpectedHeadSHA: head1})
			return err
		})
		measure("merge", func(s *Store) error {
			_, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash, ExpectedHeadSHA: head1})
			return err
		})
	})

	t.Run("mutations_aged_panel_and_read", func(t *testing.T) {
		head1 := fmt.Sprintf("%040d", 1)
		nonPollCalls := func(w *fakeWriter, from int) (total, fullFetches int) {
			calls, _ := w.snapshot()
			for _, c := range calls[from:] {
				if c.op == "Poll" || c.op == "PullRequestDetails" || c.op == "DefaultBranchChecks" || c.op == "PollProjects" {
					continue
				}
				total++
				if c.op == "PullRequestFull" {
					fullFetches++
				}
			}
			return total, fullFetches
		}
		measure := func(name string, mutate func(*Store) error) {
			t.Helper()
			g, w, s, clk, _ := mergeWorld(t)
			g.edit("PR_1", func(p *PullRequest) { p.Author = "kim" })
			if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
				t.Fatal(err)
			}
			clk.advance(2 * time.Hour)
			from := w.ncalls()
			if err := mutate(s); err != nil {
				t.Fatalf("%s mutate: %v", name, err)
			}
			if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
				t.Fatalf("%s post-read: %v", name, err)
			}
			settleWorker(t, s)
			totalGQL, fullFetches := nonPollCalls(w, from)
			t.Logf("METRIC mutation_aged_%s: graphql_requests=%d pull_request_full=%d", name, totalGQL, fullFetches)
		}
		measure("add_comment", func(s *Store) error {
			_, err := s.AddPullRequestComment(ctx, "o/r", 1, "looks good")
			return err
		})
		measure("submit_review", func(s *Store) error {
			_, err := s.SubmitPullRequestReview(ctx, "o/r", 1, ReviewSubmission{Event: ReviewEventApprove, Body: "lgtm"})
			return err
		})
		measure("set_draft", func(s *Store) error {
			_, err := s.SetPullRequestDraft(ctx, "o/r", 1, true)
			return err
		})
		measure("set_closed", func(s *Store) error {
			_, err := s.SetPullRequestClosed(ctx, "o/r", 1, true)
			return err
		})
		measure("set_auto_merge", func(s *Store) error {
			_, err := s.SetPullRequestAutoMerge(ctx, "o/r", 1, AutoMergeChange{Enabled: true, Method: MergeSquash, ExpectedHeadSHA: head1})
			return err
		})
	})
}

// BenchmarkReadLaneClickDuringSlowPoll measures before (single lane) vs after (read lane)
// latency for a user-waited FullPullRequest arriving 50ms into a slow poll (1.5s or 2.0s)
// with realistic production pacing (MinGap=1s, UserGap=250ms, 200ms detail fetch).
func BenchmarkReadLaneClickDuringSlowPoll(b *testing.B) {
	const (
		readRTT     = 200 * time.Millisecond
		clickOffset = 50 * time.Millisecond
	)
	for _, pollRTT := range []time.Duration{1500 * time.Millisecond, 2000 * time.Millisecond} {
		for _, mode := range []struct {
			name    string
			disable bool
		}{{"before_single_lane", true}, {"after_read_lane", false}} {
			b.Run(fmt.Sprintf("poll_%dms/%s", pollRTT.Milliseconds(), mode.name), func(b *testing.B) {
				b.ResetTimer()
				var totalDur, totalQueue time.Duration
				for range b.N {
					b.StopTimer()
					g, t0 := changeDrivenWorld()
					g.addPR(fakePR("PR_2", "o/r", 2, t0), sectionAuthored)
					r := &readLaneRunner{g: g}
					busObj := bus.New()
					polled := bus.Subscribe[Polled](busObj, 16)
					opts := Options{
						DB:              openBenchDB(b),
						Runner:          r,
						Bus:             busObj,
						MinGap:          DefaultMinGap,
						UserGap:         DefaultMinGap / userGapDivisor,
						PollInterval:    time.Hour,
						IdleInterval:    time.Hour,
						StatsInterval:   -1,
						disableReadLane: mode.disable,
					}
					s, err := New(context.Background(), opts)
					if err != nil {
						b.Fatal(err)
					}
					runCtx, cancel := context.WithCancel(context.Background())
					runDone := make(chan struct{})
					go func() { defer close(runDone); _ = s.Run(runCtx) }()
					if err := s.Track("o/r"); err != nil {
						b.Fatal(err)
					}
					// Initial warm-up poll without artificial delay.
					if err := s.Refresh(context.Background(), ""); err != nil {
						b.Fatal(err)
					}
					<-polled.C()
					// Reset lastEnd well in the past so the measured poll starts immediately.
					s.mu.Lock()
					s.lastEnd = time.Now().Add(-10 * time.Second)
					s.mu.Unlock()

					pollStarted := make(chan struct{})
					var pollOnce sync.Once
					var readStarted atomic.Int64
					r.mu.Lock()
					r.onOp = func(_ context.Context, op string, _ bool) {
						switch op {
						case "Poll":
							pollOnce.Do(func() { close(pollStarted) })
							time.Sleep(pollRTT)
						case "PullRequestFull":
							readStarted.Store(time.Now().UnixNano())
							time.Sleep(readRTT)
						}
					}
					r.mu.Unlock()

					if err := s.Refresh(context.Background(), ""); err != nil {
						b.Fatal(err)
					}
					<-pollStarted
					time.Sleep(clickOffset)

					b.StartTimer()
					tStart := time.Now()
					if _, err := s.FullPullRequest(context.Background(), "o/r", 1, true); err != nil {
						b.Fatal(err)
					}
					elapsed := time.Since(tStart)
					b.StopTimer()

					qWait := time.Duration(readStarted.Load() - tStart.UnixNano())
					totalDur += elapsed
					totalQueue += qWait
					<-polled.C()
					cancel()
					<-runDone
				}
				b.ReportMetric(float64(totalDur.Milliseconds())/float64(b.N), "total_ms/op")
				b.ReportMetric(float64(totalQueue.Milliseconds())/float64(b.N), "queue_wait_ms/op")
			})
		}
	}
}

// BenchmarkReadLaneBurst3DuringSlowPoll measures before (single lane) vs after (read lane)
// for a burst of 3 concurrent user-waited reads (FullPullRequest, PullRequestDiff,
// ReviewerCandidates) arriving 50ms into a 2.0s poll with realistic production pacing.
func BenchmarkReadLaneBurst3DuringSlowPoll(b *testing.B) {
	const (
		pollRTT     = 2000 * time.Millisecond
		readRTT     = 200 * time.Millisecond
		clickOffset = 50 * time.Millisecond
	)
	for _, mode := range []struct {
		name    string
		disable bool
	}{{"before_single_lane", true}, {"after_read_lane", false}} {
		b.Run(mode.name, func(b *testing.B) {
			b.ResetTimer()
			var totalFirst, totalAll time.Duration
			for range b.N {
				b.StopTimer()
				g, _ := changeDrivenWorld()
				g.detail.assignable = []ReviewerCandidate{{ID: "U1", Login: "alice", Name: "Alice"}}
				r := &readLaneRunner{g: g}
				busObj := bus.New()
				polled := bus.Subscribe[Polled](busObj, 16)
				opts := Options{
					DB:              openBenchDB(b),
					Runner:          r,
					Bus:             busObj,
					MinGap:          DefaultMinGap,
					UserGap:         DefaultMinGap / userGapDivisor,
					PollInterval:    time.Hour,
					IdleInterval:    time.Hour,
					StatsInterval:   -1,
					disableReadLane: mode.disable,
				}
				s, err := New(context.Background(), opts)
				if err != nil {
					b.Fatal(err)
				}
				runCtx, cancel := context.WithCancel(context.Background())
				runDone := make(chan struct{})
				go func() { defer close(runDone); _ = s.Run(runCtx) }()
				if err := s.Track("o/r"); err != nil {
					b.Fatal(err)
				}
				if err := s.Refresh(context.Background(), ""); err != nil {
					b.Fatal(err)
				}
				<-polled.C()
				s.mu.Lock()
				s.lastEnd = time.Now().Add(-10 * time.Second)
				s.mu.Unlock()

				pollStarted := make(chan struct{})
				var pollOnce sync.Once
				r.mu.Lock()
				r.onOp = func(_ context.Context, op string, _ bool) {
					if op == "Poll" {
						pollOnce.Do(func() { close(pollStarted) })
						time.Sleep(pollRTT)
						return
					}
					time.Sleep(readRTT)
				}
				r.mu.Unlock()

				if err := s.Refresh(context.Background(), ""); err != nil {
					b.Fatal(err)
				}
				<-pollStarted
				time.Sleep(clickOffset)

				b.StartTimer()
				tStart := time.Now()
				firstDone := make(chan time.Duration, 3)
				var wg sync.WaitGroup
				wg.Go(func() {
					if _, err := s.FullPullRequest(context.Background(), "o/r", 1, true); err != nil {
						b.Error(err)
					}
					firstDone <- time.Since(tStart)
				})
				wg.Go(func() {
					if _, err := s.PullRequestDiff(context.Background(), "o/r", 1, true); err != nil {
						b.Error(err)
					}
					firstDone <- time.Since(tStart)
				})
				wg.Go(func() {
					if _, err := s.ReviewerCandidates(context.Background(), "o/r", 1, "al"); err != nil {
						b.Error(err)
					}
					firstDone <- time.Since(tStart)
				})
				d1 := <-firstDone
				wg.Wait()
				allDur := time.Since(tStart)
				b.StopTimer()

				totalFirst += d1
				totalAll += allDur
				<-polled.C()
				cancel()
				<-runDone
			}
			b.ReportMetric(float64(totalFirst.Milliseconds())/float64(b.N), "first_ms/op")
			b.ReportMetric(float64(totalAll.Milliseconds())/float64(b.N), "all3_ms/op")
		})
	}
}

// TestReadLaneLiveMeasurement performs a small opt-in read-only measurement against live
// GitHub (alexwaumann/code-foundry #904) when GH_LIVE_MEASURE=1 is set. Skipped by default.
func TestReadLaneLiveMeasurement(t *testing.T) {
	if os.Getenv("GH_LIVE_MEASURE") != "1" {
		t.Skip("set GH_LIVE_MEASURE=1 to run live read-only GitHub measurement")
	}
	for _, mode := range []struct {
		name    string
		disable bool
	}{{"before_single_lane", true}, {"after_read_lane", false}} {
		t.Run(mode.name, func(t *testing.T) {
			httpRunner := NewHTTPRunner(HTTPOptions{UserAgent: "code-foundry-bench"})
			var pollStartNano atomic.Int64
			var pollEntered sync.Once
			pollCh := make(chan struct{})
			wrap := &timingRunner{
				HTTPRunner: httpRunner,
				onGraphQL: func(op string) {
					if op == "Poll" {
						pollEntered.Do(func() {
							pollStartNano.Store(time.Now().UnixNano())
							close(pollCh)
						})
					}
				},
			}
			b := bus.New()
			polled := bus.Subscribe[Polled](b, 16)
			opts := Options{
				DB:              openTestDB(t),
				Runner:          wrap,
				Bus:             b,
				MinGap:          DefaultMinGap,
				UserGap:         DefaultMinGap / userGapDivisor,
				PollInterval:    time.Hour,
				IdleInterval:    time.Hour,
				StatsInterval:   -1,
				disableReadLane: mode.disable,
			}
			s := startStore(t, opts)
			if err := s.Track("alexwaumann/code-foundry"); err != nil {
				t.Fatal(err)
			}
			if err := s.Refresh(context.Background(), ""); err != nil {
				t.Fatal(err)
			}
			<-pollCh
			time.Sleep(50 * time.Millisecond)
			tStart := time.Now()
			d, err := s.FullPullRequest(context.Background(), "alexwaumann/code-foundry", 904, true)
			elapsed := time.Since(tStart)
			if err != nil {
				t.Fatalf("FullPullRequest: %v", err)
			}
			<-polled.C()
			pollDur := time.Since(time.Unix(0, pollStartNano.Load()))
			t.Logf("LIVE %s: pr=#%d title=%q full_pr_ms=%d poll_total_ms=%d",
				mode.name, d.PullRequest.Number, d.PullRequest.Title, elapsed.Milliseconds(), pollDur.Milliseconds())
		})
	}
}

type timingRunner struct {
	*HTTPRunner
	onGraphQL func(op string)
}

func (r *timingRunner) GraphQL(ctx context.Context, query string, vars map[string]any) (json.RawMessage, error) {
	if m := opRE.FindStringSubmatch(query); len(m) > 1 && r.onGraphQL != nil {
		r.onGraphQL(m[1])
	}
	return r.HTTPRunner.GraphQL(ctx, query, vars)
}

// BenchmarkHotPollDetectionLatency measures before (HotPollInterval: -1, waiting for the
// regular poll) vs after (HotPollInterval: 1/4 of PollInterval, matching 15s vs 60s at
// 100x time scale: 150ms vs 600ms) detection latency from a GitHub CI or mergeability
// transition to PullRequestDetailUpdated firing on an open PR panel.
func BenchmarkHotPollDetectionLatency(b *testing.B) {
	const (
		scaledPoll = 600 * time.Millisecond // 100x scaled 60s
		scaledHot  = 150 * time.Millisecond // 100x scaled 15s
		flipOffset = 50 * time.Millisecond  // 100x scaled 5s after last poll
	)
	scenarios := []struct {
		name  string
		setup func(*PullRequest)
		flip  func(*PullRequest)
	}{
		{
			name: "ci_pending_to_success",
			setup: func(p *PullRequest) {
				p.Checks = CheckRollup{State: RollupPending, Total: 8, Passed: 2, Pending: 6}
			},
			flip: func(p *PullRequest) {
				p.Checks = CheckRollup{State: RollupSuccess, Total: 8, Passed: 8}
			},
		},
		{
			name: "mergeable_unknown_to_mergeable",
			setup: func(p *PullRequest) {
				p.Checks = CheckRollup{State: RollupSuccess, Total: 4, Passed: 4}
				p.Mergeable = MergeableUnknown
				p.MergeStateStatus = "UNKNOWN"
			},
			flip: func(p *PullRequest) {
				p.Mergeable = MergeableMergeable
				p.MergeStateStatus = "CLEAN"
			},
		},
	}
	for _, sc := range scenarios {
		for _, mode := range []struct {
			name   string
			hotInt time.Duration
		}{{"before_poll_only", -1}, {"after_hot_poll", scaledHot}} {
			b.Run(sc.name+"/"+mode.name, func(b *testing.B) {
				var totalDetect time.Duration
				var totalPolls, totalHot int64
				b.ResetTimer()
				for range b.N {
					b.StopTimer()
					g, _ := changeDrivenWorld()
					g.edit("PR_a", sc.setup)
					f := (&fakeRunner{}).serve(g)
					busObj := bus.New()
					polled := bus.Subscribe[Polled](busObj, 16)
					detailSub := bus.Subscribe[PullRequestDetailUpdated](busObj, 16)
					opts := Options{
						DB:              openBenchDB(b),
						Runner:          f,
						Bus:             busObj,
						MinGap:          10 * time.Millisecond,
						UserGap:         5 * time.Millisecond,
						PollInterval:    scaledPoll,
						HotPollInterval: mode.hotInt,
						IdleInterval:    time.Hour,
						StatsInterval:   -1,
					}
					s, err := New(context.Background(), opts)
					if err != nil {
						b.Fatal(err)
					}
					runCtx, cancel := context.WithCancel(context.Background())
					runDone := make(chan struct{})
					go func() { defer close(runDone); _ = s.Run(runCtx) }()
					if err := s.Track("o/r"); err != nil {
						b.Fatal(err)
					}
					<-polled.C()
					if _, err := s.FullPullRequest(context.Background(), "o/r", 1, false); err != nil {
						b.Fatal(err)
					}
					// Wait for one clean poll cycle boundary so pollNext = +scaledPoll, hotNext = +scaledHot.
					<-polled.C()
					pollsBefore := f.count("Poll")
					hotBefore := f.count("PullRequestHot")

					time.Sleep(flipOffset)
					b.StartTimer()
					tFlip := time.Now()
					g.edit("PR_a", sc.flip)
					// Before mode on mergeable resolution without UpdatedAt bump relies on
					// regular poll recheck or detail age; wait for PullRequestDetailUpdated or
					// next Polled when no PullRequestDetailUpdated fires.
					detected := false
					timeout := time.NewTimer(2 * scaledPoll)
					for !detected {
						select {
						case ev := <-detailSub.C():
							if ev.Slug == "o/r" && ev.Number == 1 {
								detected = true
							}
						case <-polled.C():
							if mode.hotInt < 0 && sc.name == "mergeable_unknown_to_mergeable" {
								// Regular Poll's fingerprint does not select mergeable, so a
								// mergeable-only transition without UpdatedAt bump waits for
								// the poll cycle / detail TTL.
								detected = true
							}
						case <-timeout.C:
							b.Fatal("timed out waiting for transition detection")
						}
					}
					elapsed := time.Since(tFlip)
					timeout.Stop()
					b.StopTimer()

					totalDetect += elapsed
					totalPolls += int64(f.count("Poll") - pollsBefore)
					totalHot += int64(f.count("PullRequestHot") - hotBefore)
					cancel()
					<-runDone
				}
				b.ReportMetric(float64(totalDetect.Milliseconds())/float64(b.N), "detect_ms/op")
				b.ReportMetric(float64(totalPolls)/float64(b.N), "poll_calls/op")
				b.ReportMetric(float64(totalHot)/float64(b.N), "hot_poll_calls/op")
			})
		}
	}
}

// TestHotPollLiveMeasurement runs opt-in read-only measurements against live GitHub
// (alexwaumann/code-foundry) when GH_LIVE_MEASURE=1 is set: compares PullRequestHot
// (1 PR and 5 PRs) RTT, payload bytes, and GraphQL cost against a full Poll query.
func TestHotPollLiveMeasurement(t *testing.T) {
	if os.Getenv("GH_LIVE_MEASURE") != "1" {
		t.Skip("set GH_LIVE_MEASURE=1 to run live read-only GitHub measurement")
	}
	ctx := context.Background()
	httpRunner := NewHTTPRunner(HTTPOptions{UserAgent: "code-foundry-hot-bench"})
	defer httpRunner.Close()

	// Discover up to 5 recent PR node IDs on alexwaumann/code-foundry via a single read-only query.
	const listDoc = `query ListRecentPRs($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { id number state }
    }
  }
}`
	rawList, err := httpRunner.GraphQL(ctx, listDoc, map[string]any{"owner": "alexwaumann", "name": "code-foundry"})
	if err != nil {
		t.Fatalf("list recent PRs: %v", err)
	}
	var listResp struct {
		Repository struct {
			PullRequests struct {
				Nodes []struct {
					ID     string `json:"id"`
					Number int    `json:"number"`
					State  string `json:"state"`
				} `json:"nodes"`
			} `json:"pullRequests"`
		} `json:"repository"`
	}
	if err := json.Unmarshal(rawList, &listResp); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, n := range listResp.Repository.PullRequests.Nodes {
		if n.ID != "" {
			ids = append(ids, n.ID)
		}
	}
	if len(ids) == 0 {
		t.Fatal("no PR IDs found on alexwaumann/code-foundry")
	}

	hotDoc, err := query(queryPullRequestHot)
	if err != nil {
		t.Fatal(err)
	}
	measureHot := func(label string, batch []string) {
		t.Helper()
		start := time.Now()
		data, err := httpRunner.GraphQL(ctx, hotDoc, map[string]any{"ids": batch})
		dur := time.Since(start)
		if err != nil {
			t.Fatalf("PullRequestHot(%s): %v", label, err)
		}
		var env struct {
			RateLimit rateLimitJSON `json:"rateLimit"`
		}
		_ = json.Unmarshal(data, &env)
		nodes, err := decodeHotNodes(data)
		if err != nil {
			t.Fatalf("decodeHotNodes(%s): %v", label, err)
		}
		t.Logf("LIVE PullRequestHot(%s): ids=%d decoded=%d rtt_ms=%d bytes=%d cost=%d remaining=%d",
			label, len(batch), len(nodes), dur.Milliseconds(), len(data), env.RateLimit.Cost, env.RateLimit.Remaining)
	}
	measureHot("1_pr", ids[:1])
	measureHot(fmt.Sprintf("%d_prs", len(ids)), ids)

	// Measure one full Poll query (dashboards + tracked alexwaumann/code-foundry) for comparison.
	plan := pollPlan{
		sections: dashboardSections("@me", time.Now()),
		repos:    []repoPlan{{slug: "alexwaumann/code-foundry", defaultBranch: true}},
	}
	pollDoc, pollVars, err := plan.build()
	if err != nil {
		t.Fatal(err)
	}
	pStart := time.Now()
	pData, pErr := httpRunner.GraphQL(ctx, pollDoc, pollVars)
	pDur := time.Since(pStart)
	if pErr != nil && !isPartial(pErr) {
		t.Fatalf("Poll: %v", pErr)
	}
	var pEnv struct {
		RateLimit rateLimitJSON `json:"rateLimit"`
	}
	_ = json.Unmarshal(pData, &pEnv)
	t.Logf("LIVE Poll(dashboards+1_repo): rtt_ms=%d bytes=%d cost=%d remaining=%d",
		pDur.Milliseconds(), len(pData), pEnv.RateLimit.Cost, pEnv.RateLimit.Remaining)
}
