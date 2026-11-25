package gh

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

func TestPullRequestUsesInMemoryCacheBeforeSQLite(t *testing.T) {
	ctx := context.Background()
	g, _ := changeDrivenWorld()
	f := &fakeRunner{}
	f.setDoc(answerPullRequest(g))
	db := &countingDB{DB: openTestDB(t)}
	opts := testOptions(db, f, nil)
	opts.DetailTTL = time.Hour
	s := startStore(t, opts)

	// Cold fetch: 1 GraphQL call, populates in-memory detail + summary index + SQLite.
	d, err := s.PullRequest(ctx, "o/r", 1)
	if err != nil || d.PullRequest.Number != 1 {
		t.Fatalf("first PullRequest = %+v, %v", d, err)
	}
	if p, ok := s.summaries.get(fullKey{"o/r", 1}); !ok || p.Number != 1 {
		t.Errorf("summary index missing #1: %+v, %v", p, ok)
	}

	// Second call: served from in-memory prDetails with 0 SQLite queries and 0 GraphQL calls.
	db.queries.Store(0)
	beforeGQL := f.count("PullRequest")
	d2, err := s.PullRequest(ctx, "o/r", 1)
	if err != nil || d2.PullRequest.Number != 1 {
		t.Fatalf("cached PullRequest = %+v, %v", d2, err)
	}
	if q := db.queries.Load(); q != 0 {
		t.Errorf("in-memory PullRequest hit ran %d SQLite queries, want 0", q)
	}
	if n := f.count("PullRequest") - beforeGQL; n != 0 {
		t.Errorf("in-memory PullRequest hit ran %d GraphQL calls, want 0", n)
	}

	// Restart on the same DB: first PullRequest hydrates from SQLite, second hits memory.
	f2 := &fakeRunner{}
	f2.setDoc(answerPullRequest(g))
	db2 := &countingDB{DB: db.DB}
	opts2 := testOptions(db2, f2, nil)
	opts2.DetailTTL = time.Hour
	s2 := startStore(t, opts2)
	db2.queries.Store(0)
	if _, err := s2.PullRequest(ctx, "o/r", 1); err != nil {
		t.Fatal(err)
	}
	if q := db2.queries.Load(); q != 1 {
		t.Errorf("SQLite hydration read ran %d queries, want 1", q)
	}
	db2.queries.Store(0)
	if _, err := s2.PullRequest(ctx, "o/r", 1); err != nil {
		t.Fatal(err)
	}
	if q := db2.queries.Load(); q != 0 || f2.count("PullRequest") != 0 {
		t.Errorf("post-hydration PullRequest ran %d SQLite queries and %d GraphQL calls, want 0", q, f2.count("PullRequest"))
	}
}

func TestPullRequestUsesFullCacheBeforeSQLite(t *testing.T) {
	ctx := context.Background()
	g, _ := changeDrivenWorld()
	f := &fakeRunner{}
	f.setDoc(answerPullRequest(g))
	db := &countingDB{DB: openTestDB(t)}
	opts := testOptions(db, f, nil)
	opts.DetailTTL = time.Hour
	s := startStore(t, opts)

	// Populate s.full via FullPullRequest; PullRequest should hit it with 0 SQLite / 0 GraphQL.
	if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
		t.Fatal(err)
	}
	db.queries.Store(0)
	beforeGQL := f.count("PullRequest")
	d, err := s.PullRequest(ctx, "o/r", 1)
	if err != nil || d.PullRequest.ID != "PR_a" {
		t.Fatalf("PullRequest from full cache = %+v, %v", d, err)
	}
	if q := db.queries.Load(); q != 0 || f.count("PullRequest") != beforeGQL {
		t.Errorf("PullRequest after FullPullRequest ran %d SQLite queries, %d GraphQL calls; want 0", q, f.count("PullRequest")-beforeGQL)
	}
}

func TestSQLiteHydrationFingerprintValidation(t *testing.T) {
	ctx := context.Background()

	t.Run("unchanged open and merged PR skip refetch after live poll", func(t *testing.T) {
		g, _ := changeDrivenWorld()
		g.setBody("PR_a", "open body")
		g.setBody("PR_c", "merged body")
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
		if _, err := s1.FullPullRequest(ctx, "o/r", 3, false); err != nil {
			t.Fatal(err)
		}

		clk.advance(10 * time.Second)
		f2 := (&fakeRunner{}).serve(g)
		opts2 := testOptions(db, f2, nil)
		opts2.Now = clk.now
		s2 := startStore(t, opts2)
		if err := s2.Track("o/r"); err != nil {
			t.Fatal(err)
		}
		pollOnce(t, s2, f2)

		d1, err := s2.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil || d1.Body != "open body" || d1.Refreshing {
			t.Errorf("open PR after restart+poll: body %q refreshing %v err %v", d1.Body, d1.Refreshing, err)
		}
		d3, err := s2.FullPullRequest(ctx, "o/r", 3, false)
		if err != nil || d3.Body != "merged body" || d3.Refreshing {
			t.Errorf("merged PR after restart+poll: body %q refreshing %v err %v", d3.Body, d3.Refreshing, err)
		}
		settleWorker(t, s2)
		if n := f2.count("PullRequestFull"); n != 0 {
			t.Errorf("PullRequestFull fetches = %d, want 0", n)
		}
	})

	t.Run("local write invalidates SQLite hydration", func(t *testing.T) {
		g, _ := changeDrivenWorld()
		g.setBody("PR_a", "v1")
		db := openTestDB(t)
		clk := &testClock{}
		f := (&fakeRunner{}).serve(g)
		opts := testOptions(db, f, nil)
		opts.Now = clk.now
		s := startStore(t, opts)
		if err := s.Track("o/r"); err != nil {
			t.Fatal(err)
		}
		pollOnce(t, s, f)
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		// Evict from memory, then mark written locally and poll.
		s.full.mu.Lock()
		delete(s.full.m, fullKey{"o/r", 1})
		s.full.mu.Unlock()
		clk.advance(time.Second)
		s.invalidateFull(fullKey{"o/r", 1})
		clk.advance(time.Second)
		pollOnce(t, s, f)

		before := f.count("PullRequestFull")
		d, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil || !d.Refreshing {
			t.Errorf("after local write: refreshing %v err %v; want stale", d.Refreshing, err)
		}
		settleWorker(t, s)
		if n := f.count("PullRequestFull") - before; n != 1 {
			t.Errorf("fetches = %d, want 1", n)
		}
	})

	t.Run("prMatchesFingerprint checks every fingerprint field", func(t *testing.T) {
		t0 := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
		base := PullRequest{
			ID: "PR_1", Number: 1, Repo: "o/r", State: PullRequestOpen, UpdatedAt: t0, HeadSHA: "h1",
			Checks: CheckRollup{State: RollupSuccess, Total: 3, Passed: 3},
		}
		fp := prFingerprint{
			ID: "PR_1", Number: 1, Repo: "o/r", State: PullRequestOpen, UpdatedAt: t0, HeadSHA: "h1",
			HasChecks: true, Checks: base.Checks,
		}
		if !prMatchesFingerprint(base, fp) {
			t.Fatal("identical open PR did not match")
		}
		mutations := []struct {
			name string
			fn   func(*prFingerprint)
		}{
			{"ID", func(f *prFingerprint) { f.ID = "PR_other" }},
			{"UpdatedAt", func(f *prFingerprint) { f.UpdatedAt = t0.Add(time.Second) }},
			{"HeadSHA", func(f *prFingerprint) { f.HeadSHA = "h2" }},
			{"State", func(f *prFingerprint) { f.State = PullRequestClosed }},
			{"Checks", func(f *prFingerprint) { f.Checks.Passed = 2 }},
		}
		for _, tc := range mutations {
			t.Run(tc.name, func(t *testing.T) {
				m := fp
				tc.fn(&m)
				if prMatchesFingerprint(base, m) {
					t.Errorf("%s change still matched", tc.name)
				}
			})
		}
		// Open PR without checks in fingerprint cannot be validated.
		noChecks := fp
		noChecks.HasChecks = false
		if prMatchesFingerprint(base, noChecks) {
			t.Error("open PR matched without checks")
		}
		// Merged PR without checks in fingerprint still matches.
		cachedMerged := base
		cachedMerged.State = PullRequestMerged
		fpMerged := prFingerprint{ID: "PR_1", Number: 1, Repo: "o/r", State: PullRequestMerged, UpdatedAt: t0, HeadSHA: "h1"}
		if !prMatchesFingerprint(cachedMerged, fpMerged) {
			t.Error("merged PR did not match summary-only fingerprint")
		}
	})

	t.Run("failed detail fetch after updatedAt move does not validate stale SQLite row", func(t *testing.T) {
		g, _ := changeDrivenWorld()
		g.setBody("PR_a", "v1")
		db := openTestDB(t)
		clk := &testClock{}
		f := (&fakeRunner{}).serve(g)
		opts := testOptions(db, f, nil)
		opts.Now = clk.now
		s := startStore(t, opts)
		if err := s.Track("o/r"); err != nil {
			t.Fatal(err)
		}
		pollOnce(t, s, f)
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		// Evict from memory, move UpdatedAt on GitHub, and make PullRequestDetails fail
		// so resolveFingerprints carries the old Dashboard copy forward while the live
		// fingerprint carries the new UpdatedAt.
		s.full.mu.Lock()
		delete(s.full.m, fullKey{"o/r", 1})
		s.full.mu.Unlock()
		clk.advance(time.Minute)
		g.edit("PR_a", func(p *PullRequest) { p.UpdatedAt = p.UpdatedAt.Add(time.Minute) })
		g.failNext("PullRequestDetails", fmt.Errorf("transient detail failure"))
		pollOnce(t, s, f)
		// Clear moved mark to prove fingerprint validation itself rejects the stale row.
		s.moved.mu.Lock()
		s.moved.m = nil
		s.moved.mu.Unlock()

		before := f.count("PullRequestFull")
		d, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil || !d.Refreshing {
			t.Fatalf("after UpdatedAt move + failed detail batch: refreshing=%v err=%v; want stale", d.Refreshing, err)
		}
		settleWorker(t, s)
		if n := f.count("PullRequestFull") - before; n != 1 {
			t.Errorf("PullRequestFull fetches = %d, want 1", n)
		}
	})
}

func TestPendingCheckCountsPatchedInPlace(t *testing.T) {
	t0 := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	now := t0.Add(time.Minute)
	base := PullRequest{
		ID: "PR_a", Number: 1, Repo: "o/r", State: PullRequestOpen, UpdatedAt: t0, HeadSHA: "h1",
		Mergeable: MergeableMergeable, MergeStateStatus: "CLEAN",
		Checks: CheckRollup{State: RollupPending, Total: 12, Passed: 5, Failed: 0, Pending: 7},
	}
	fpOf := func(p PullRequest) prFingerprint {
		return prFingerprint{ID: p.ID, Number: p.Number, Repo: p.Repo, UpdatedAt: p.UpdatedAt, State: p.State, HeadSHA: p.HeadSHA, HasChecks: true, Checks: p.Checks}
	}

	tests := []struct {
		name      string
		mutate    func(*PullRequest)
		wantStale bool
		wantKeys  int
	}{
		{
			name:      "pending count ticks forward: patched in place, not stale",
			mutate:    func(p *PullRequest) { p.Checks = CheckRollup{State: RollupPending, Total: 12, Passed: 6, Pending: 6} },
			wantStale: false, wantKeys: 1,
		},
		{
			name: "new failure while still pending: goes stale",
			mutate: func(p *PullRequest) {
				p.Checks = CheckRollup{State: RollupPending, Total: 12, Passed: 5, Failed: 1, Pending: 6}
			},
			wantStale: true, wantKeys: 1,
		},
		{
			name:      "CI finishes passing: goes stale",
			mutate:    func(p *PullRequest) { p.Checks = CheckRollup{State: RollupSuccess, Total: 12, Passed: 12} },
			wantStale: true, wantKeys: 1,
		},
		{
			name:      "CI finishes failing: goes stale",
			mutate:    func(p *PullRequest) { p.Checks = CheckRollup{State: RollupFailure, Total: 12, Passed: 11, Failed: 1} },
			wantStale: true, wantKeys: 1,
		},
		{
			name: "updatedAt also moved while pending: goes stale",
			mutate: func(p *PullRequest) {
				p.UpdatedAt = t0.Add(time.Second)
				p.Checks = CheckRollup{State: RollupPending, Total: 12, Passed: 6, Pending: 6}
			},
			wantStale: true, wantKeys: 1,
		},
		{
			name: "head SHA moved while pending: goes stale",
			mutate: func(p *PullRequest) {
				p.HeadSHA = "h2"
				p.Checks = CheckRollup{State: RollupPending, Total: 12, Passed: 6, Pending: 6}
			},
			wantStale: true, wantKeys: 1,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var c fullCache
			k := fullKey{"o/r", 1}
			c.put(k, FullPullRequest{PullRequest: base, FetchedAt: t0})
			next := base
			tt.mutate(&next)
			keys := c.applyPoll([]prFingerprint{fpOf(next)}, now)
			e, _ := c.entry(k)
			if len(keys) != tt.wantKeys || e.stale != tt.wantStale {
				t.Errorf("keys=%v stale=%v; want %d keys stale=%v", keys, e.stale, tt.wantKeys, tt.wantStale)
			}
			if !tt.wantStale {
				if e.d.PullRequest.Checks != next.Checks || !e.checksStale {
					t.Errorf("checks-only patch: checks=%+v checksStale=%v; want %+v checksStale=true", e.d.PullRequest.Checks, e.checksStale, next.Checks)
				}
			}
		})
	}
}

func TestPendingCICheckTicksAvoidFullRefetchUntilSettle(t *testing.T) {
	ctx := context.Background()
	b := bus.New()
	events := bus.Subscribe[PullRequestDetailUpdated](b, 64)
	g, _ := changeDrivenWorld()
	g.edit("PR_a", func(p *PullRequest) {
		p.Checks = CheckRollup{State: RollupPending, Total: 12, Passed: 1, Pending: 11}
	})
	f := &fakeRunner{}
	f.setDoc(answerPullRequest(g))
	clk := &testClock{}
	opts := testOptions(openTestDB(t), f, b)
	opts.Now = clk.now
	opts.DetailTTL = time.Hour
	s := startStore(t, opts)
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, f)

	if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PullRequest(ctx, "o/r", 1); err != nil {
		t.Fatal(err)
	}
	drain(events)
	fullBefore := f.count("PullRequestFull")
	checksBefore := f.count("Checks")

	for i := 2; i <= 6; i++ {
		clk.advance(30 * time.Second)
		g.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupPending, Total: 12, Passed: i, Pending: 12 - i}
		})
		pollOnce(t, s, f)
		if got := drain(events); got != 1 {
			t.Fatalf("tick %d: PullRequestDetailUpdated = %d, want 1", i, got)
		}
		// Immediate stale-first read carries the patched summary counts and triggers a
		// lightweight checks.graphql refresh (not PullRequestFull) to update check rows.
		d, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if !d.Refreshing || d.PullRequest.Checks.Passed != i || d.PullRequest.Checks.Pending != 12-i {
			t.Errorf("tick %d: refreshing=%v checks=%+v", i, d.Refreshing, d.PullRequest.Checks)
		}
		settleWorker(t, s)
		drain(events)
		// After checks.graphql settles, individual check rows are fresh and Refreshing is false.
		d2, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		wantCheck := fmt.Sprintf("ci-%d-of-12", i)
		if d2.Refreshing || len(d2.Checks) == 0 || d2.Checks[0].Name != wantCheck {
			t.Errorf("tick %d post-checks: refreshing=%v checks=%+v, want %s", i, d2.Refreshing, d2.Checks, wantCheck)
		}
	}
	if n := f.count("PullRequestFull") - fullBefore; n != 0 {
		t.Errorf("pending CI ticks sent %d PullRequestFull fetches, want 0", n)
	}
	if n := f.count("Checks") - checksBefore; n != 5 {
		t.Errorf("pending CI ticks sent %d lightweight Checks fetches, want 5", n)
	}

	// Once CI settles to SUCCESS, FullPullRequest refetches full detail.
	clk.advance(30 * time.Second)
	g.edit("PR_a", func(p *PullRequest) {
		p.Checks = CheckRollup{State: RollupSuccess, Total: 12, Passed: 12}
	})
	pollOnce(t, s, f)
	if got := drain(events); got != 1 {
		t.Fatalf("settle: PullRequestDetailUpdated = %d, want 1", got)
	}
	d, err := s.FullPullRequest(ctx, "o/r", 1, false)
	if err != nil || !d.Refreshing {
		t.Errorf("after CI settled: refreshing=%v err=%v; want stale+refreshing", d.Refreshing, err)
	}
	settleWorker(t, s)
	if n := f.count("PullRequestFull") - fullBefore; n != 1 {
		t.Errorf("after CI settled: PullRequestFull = %d, want 1", n)
	}
	if pd, err := s.PullRequest(ctx, "o/r", 1); err != nil || pd.PullRequest.Checks.State != RollupSuccess {
		t.Errorf("PullRequest after settle: %+v, %v", pd, err)
	}
}

func TestReviewerCandidatesCacheAndFallback(t *testing.T) {
	ctx := context.Background()

	t.Run("small repo caches assignable users and filters keystrokes locally", func(t *testing.T) {
		g, _ := changeDrivenWorld()
		g.edit("PR_a", func(p *PullRequest) { p.ReviewRequests = []string{"alice"} })
		g.detail.assignable = []ReviewerCandidate{
			{ID: "U0", Login: "octocat", Name: "The Author"},
			{ID: "U1", Login: "alice", Name: "Alice Requested"},
			{ID: "U2", Login: "jdoe", Name: "Doe, Jane"},
			{ID: "U3", Login: "janet", Name: "Janet Smith"},
			{ID: "U4", Login: "jane-doe-bot", Name: ""},
		}
		f := (&fakeRunner{}).serve(g)
		clk := &testClock{}
		opts := testOptions(openTestDB(t), f, nil)
		opts.Now = clk.now
		s := startStore(t, opts)

		// Opening the picker (empty query) fetches pending requests + all assignable users in 1 request.
		openRes, err := s.ReviewerCandidates(ctx, "o/r", 1, "")
		if err != nil {
			t.Fatal(err)
		}
		if len(openRes.Candidates) != 1 || openRes.Candidates[0].Login != "alice" || !openRes.Candidates[0].Requested {
			t.Fatalf("open picker = %+v", openRes.Candidates)
		}
		if n := f.count("ReviewerCandidates"); n != 1 {
			t.Fatalf("requests after open = %d, want 1", n)
		}

		// Subsequent keystrokes cost 0 GitHub requests.
		for _, tc := range []struct {
			q    string
			want []string
		}{
			{"j", []string{"alice", "jane-doe-bot", "janet", "jdoe"}},
			{"jane", []string{"alice", "jane-doe-bot", "janet", "jdoe"}},
			{"jane doe", []string{"alice", "jane-doe-bot", "jdoe"}},
			{"octocat", []string{"alice"}}, // author excluded
		} {
			res, err := s.ReviewerCandidates(ctx, "o/r", 1, tc.q)
			if err != nil {
				t.Fatalf("query %q: %v", tc.q, err)
			}
			var got []string
			for _, c := range res.Candidates {
				got = append(got, c.Login)
			}
			if !slices.Equal(got, tc.want) {
				t.Errorf("query %q: got %v, want %v", tc.q, got, tc.want)
			}
		}
		if n := f.count("ReviewerCandidates"); n != 1 {
			t.Errorf("requests after keystrokes = %d, want 1", n)
		}

		// Another PR in the same repo reuses repo assignable cache (1 lightweight PR request, 0 for keystrokes).
		res2, err := s.ReviewerCandidates(ctx, "o/r", 2, "jane doe")
		if err != nil {
			t.Fatal(err)
		}
		if n := f.count("ReviewerCandidates"); n != 2 {
			t.Errorf("requests for PR #2 = %d, want 2", n)
		}
		calls, _ := f.snapshot()
		last := calls[len(calls)-1]
		if last.vars["all"] != false || last.vars["search"] != false {
			t.Errorf("PR #2 vars = %v; want all=false search=false", last.vars)
		}
		var got2 []string
		for _, c := range res2.Candidates {
			if !c.Requested {
				got2 = append(got2, c.Login)
			}
		}
		if want := []string{"jane-doe-bot", "jdoe"}; !slices.Equal(got2, want) {
			t.Errorf("PR #2 matches = %v, want %v", got2, want)
		}

		// After invalidateFull, PR review requests refresh while keeping repo assignable cache.
		s.invalidateFull(fullKey{"o/r", 1})
		if _, err := s.ReviewerCandidates(ctx, "o/r", 1, "jane"); err != nil {
			t.Fatal(err)
		}
		if n := f.count("ReviewerCandidates"); n != 3 {
			t.Errorf("requests after invalidateFull = %d, want 3", n)
		}

		// After assignableCacheTTL expires, repo assignable users are refetched.
		clk.advance(assignableCacheTTL + time.Second)
		if _, err := s.ReviewerCandidates(ctx, "o/r", 1, "jane"); err != nil {
			t.Fatal(err)
		}
		if n := f.count("ReviewerCandidates"); n != 4 {
			t.Errorf("requests after TTL = %d, want 4", n)
		}
	})

	t.Run("truncated repo (hasNextPage) falls back to GraphQL search", func(t *testing.T) {
		g, _ := changeDrivenWorld()
		for i := range 105 {
			g.detail.assignable = append(g.detail.assignable, ReviewerCandidate{
				ID:    fmt.Sprintf("U_%03d", i),
				Login: fmt.Sprintf("user-%03d", i),
				Name:  fmt.Sprintf("User %03d", i),
			})
		}
		f := (&fakeRunner{}).serve(g)
		s := startStore(t, testOptions(openTestDB(t), f, nil))

		// First query learns hasNextPage=true and caches truncated=true.
		res1, err := s.ReviewerCandidates(ctx, "o/r", 1, "user-104")
		if err != nil {
			t.Fatal(err)
		}
		if len(res1.Candidates) != 1 || res1.Candidates[0].Login != "user-104" {
			t.Fatalf("first query = %+v", res1.Candidates)
		}
		// Subsequent query falls back to GraphQL with all=false, search=true.
		res2, err := s.ReviewerCandidates(ctx, "o/r", 1, "user-103")
		if err != nil {
			t.Fatal(err)
		}
		if len(res2.Candidates) != 1 || res2.Candidates[0].Login != "user-103" {
			t.Fatalf("second query = %+v", res2.Candidates)
		}
		if n := f.count("ReviewerCandidates"); n != 2 {
			t.Errorf("requests on truncated repo = %d, want 2", n)
		}
		calls, _ := f.snapshot()
		last := calls[len(calls)-1]
		if last.vars["all"] != false || last.vars["search"] != true {
			t.Errorf("fallback vars = %v; want all=false search=true", last.vars)
		}
	})

	t.Run("LRU eviction bounds repo cache size", func(t *testing.T) {
		var c reviewerCache
		now := time.Now()
		for i := range assignableCacheMax + 5 {
			c.putRepo(fmt.Sprintf("o/r%d", i), []ReviewerCandidate{{Login: "a"}}, false, now)
		}
		if len(c.repos) != assignableCacheMax {
			t.Errorf("repo cache size = %d, want %d", len(c.repos), assignableCacheMax)
		}
		if _, _, ok := c.repo("o/r0", now); ok {
			t.Error("oldest repo was not evicted")
		}
		if _, _, ok := c.repo(fmt.Sprintf("o/r%d", assignableCacheMax+4), now); !ok {
			t.Error("newest repo was evicted")
		}
	})
}
