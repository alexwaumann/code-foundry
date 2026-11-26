package gh

import (
	"context"
	"testing"
	"time"
)

// hotQuietWorld is a store that is not running (the test drives the hot poll and the
// panel's reads itself on a fake clock) with PR #1 cached as an open detail panel would
// leave it: checks PENDING.
func hotQuietWorld(t *testing.T) (*Store, *fakeGitHub, *fakeRunner, *testClock, fullKey) {
	t.Helper()
	clk := &testClock{}
	g, _ := changeDrivenWorld()
	g.edit("PR_a", func(p *PullRequest) {
		p.Checks = CheckRollup{State: RollupPending, Total: 3, Passed: 2, Pending: 1}
	})
	f := (&fakeRunner{}).serve(g)
	opts := hotTestOptions(t, f, nil, func(o *Options) {
		o.Now = clk.now
		o.MinGap = time.Millisecond
		o.UserGap = time.Millisecond
		o.HotPollInterval = DefaultHotPollInterval
	})
	s, err := New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	k := fullKey{"o/r", 1}
	s.full.put(k, FullPullRequest{PullRequest: *g.prs["PR_a"], FetchedAt: clk.now()})
	return s, g, f, clk, k
}

// runPanel advances the fake clock by dur in HotPollInterval steps, re-reading the
// detail every keepAlive (the GUI's PULL_REQUEST_DETAIL_KEEPALIVE_MS) and running a hot
// poll on every step, as the worker would in the foreground. It returns the number of
// PullRequestHot requests sent.
func runPanel(t *testing.T, s *Store, f *fakeRunner, clk *testClock, k fullKey, dur, keepAlive time.Duration, read bool) int {
	t.Helper()
	ctx := context.Background()
	before := f.count("PullRequestHot")
	step := DefaultHotPollInterval
	var sinceRead time.Duration
	for elapsed := time.Duration(0); elapsed < dur; elapsed += step {
		clk.advance(step)
		sinceRead += step
		if read && sinceRead >= keepAlive {
			sinceRead = 0
			if _, err := s.FullPullRequest(ctx, k.slug, k.number, false); err != nil {
				t.Fatal(err)
			}
		}
		s.hotPoll(ctx)
	}
	return f.count("PullRequestHot") - before
}

// An open panel re-reads its detail every 60 s. A check that never reports keeps the
// PR PENDING; the hot poll must stop once nothing has changed for DefaultHotQuiet
// instead of polling every 15 s for as long as the panel stays open.
func TestHotPollNeverResolvingPRIsBounded(t *testing.T) {
	ctx := context.Background()
	s, _, f, clk, k := hotQuietWorld(t)
	if _, err := s.FullPullRequest(ctx, k.slug, k.number, false); err != nil {
		t.Fatal(err)
	}
	got := runPanel(t, s, f, clk, k, 2*time.Hour, time.Minute, true)
	// The open arms the first hot poll one HotPollInterval later; one follows every
	// HotPollInterval while less than DefaultHotQuiet has passed since the open:
	// 15s, 30s, ... 14m45s, so DefaultHotQuiet/HotPollInterval - 1 = 59 in all.
	want := int(DefaultHotQuiet/DefaultHotPollInterval) - 1
	if got != want {
		t.Fatalf("PullRequestHot over 2h with the panel open on a never-resolving PR = %d, want %d", got, want)
	}
	if s.hasEligibleHot(clk.now()) {
		t.Fatal("never-resolving PR still hot after DefaultHotQuiet without a change")
	}
}

// What makes a quiet PR hot again, and what does not.
func TestHotPollQuietRearm(t *testing.T) {
	ctx := context.Background()
	quiet := func(t *testing.T) (*Store, *fakeGitHub, *fakeRunner, *testClock, fullKey) {
		t.Helper()
		s, g, f, clk, k := hotQuietWorld(t)
		if _, err := s.FullPullRequest(ctx, k.slug, k.number, false); err != nil {
			t.Fatal(err)
		}
		runPanel(t, s, f, clk, k, DefaultHotQuiet+time.Minute, time.Minute, true)
		if s.hasEligibleHot(clk.now()) {
			t.Fatal("setup: PR still hot after DefaultHotQuiet")
		}
		return s, g, f, clk, k
	}

	t.Run("passive re-reads do not", func(t *testing.T) {
		s, _, f, clk, k := quiet(t)
		if got := runPanel(t, s, f, clk, k, 30*time.Minute, time.Minute, true); got != 0 {
			t.Fatalf("PullRequestHot after the quiet cap with only keep-alive reads = %d, want 0", got)
		}
	})

	t.Run("a local mutation does", func(t *testing.T) {
		s, _, _, clk, k := quiet(t)
		s.touchHotMutated(k)
		if !s.hasEligibleHot(clk.now()) {
			t.Fatal("mutated PR not hot again")
		}
	})

	t.Run("opening the panel afresh does", func(t *testing.T) {
		s, _, f, clk, k := quiet(t)
		// Panel closed: no reads until the lease lapses.
		runPanel(t, s, f, clk, k, DefaultHotLease+time.Minute, time.Minute, false)
		if _, err := s.FullPullRequest(ctx, k.slug, k.number, false); err != nil {
			t.Fatal(err)
		}
		if !s.hasEligibleHot(clk.now()) {
			t.Fatal("PR opened afresh not hot again")
		}
	})

	t.Run("a change a read returns does", func(t *testing.T) {
		s, g, _, clk, k := quiet(t)
		// The regular poll saw a check finish and the detail was refetched: the next
		// read returns the new counts.
		g.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupPending, Total: 4, Passed: 2, Pending: 2}
		})
		s.full.put(k, FullPullRequest{PullRequest: *g.prs["PR_a"], FetchedAt: clk.now()})
		if _, err := s.FullPullRequest(ctx, k.slug, k.number, false); err != nil {
			t.Fatal(err)
		}
		if !s.hasEligibleHot(clk.now()) {
			t.Fatal("PR whose read returned a change not hot again")
		}
	})
}

// CI that keeps moving (a check finishing every few minutes) stays hot for its whole
// run, and the run's end is still seen by the next hot poll.
func TestHotPollProgressingCIStaysHot(t *testing.T) {
	ctx := context.Background()
	s, g, f, clk, k := hotQuietWorld(t)
	if _, err := s.FullPullRequest(ctx, k.slug, k.number, false); err != nil {
		t.Fatal(err)
	}
	// Eight checks, one finishing every DefaultHotQuiet-1m: well past DefaultHotQuiet
	// in total, never DefaultHotQuiet without a change.
	gap := DefaultHotQuiet - time.Minute
	for passed := 3; passed <= 10; passed++ {
		runPanel(t, s, f, clk, k, gap, time.Minute, true)
		if !s.hasEligibleHot(clk.now()) {
			e, _ := s.full.entry(k)
			if !e.stale && !e.checksStale {
				t.Fatalf("PR fell out of the hot set while CI was still moving (passed=%d)", passed)
			}
		}
		g.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupPending, Total: 11, Passed: passed, Pending: 11 - passed}
		})
		// The next hot poll sees the tick; the panel then reads the patched counts.
		s.hotPoll(ctx)
		e, _ := s.full.entry(k)
		if e.d.PullRequest.Checks.Passed != passed {
			t.Fatalf("hot poll missed the tick to %d passed: entry checks %+v", passed, e.d.PullRequest.Checks)
		}
		// The checks refresh the panel's read queues lands: clear checksStale.
		s.full.put(k, FullPullRequest{PullRequest: *g.prs["PR_a"], FetchedAt: clk.now()})
	}
	g.edit("PR_a", func(p *PullRequest) {
		p.Checks = CheckRollup{State: RollupSuccess, Total: 11, Passed: 11}
	})
	runPanel(t, s, f, clk, k, DefaultHotPollInterval, time.Minute, false)
	if e, _ := s.full.entry(k); !e.stale {
		t.Fatal("CI settling not seen by the next hot poll")
	}
}
