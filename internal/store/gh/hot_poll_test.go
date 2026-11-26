package gh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

func hotTestOptions(t *testing.T, r Runner, b *bus.Bus, mutate func(*Options)) Options {
	t.Helper()
	opts := testOptions(openTestDB(t), r, b)
	opts.MinGap = 5 * time.Millisecond
	opts.UserGap = 2 * time.Millisecond
	opts.HotPollInterval = 25 * time.Millisecond
	if mutate != nil {
		mutate(&opts)
	}
	return opts
}

func startHotStore(t *testing.T, r Runner, b *bus.Bus, mutate func(*Options)) *Store {
	t.Helper()
	opts := hotTestOptions(t, r, b, mutate)
	s, err := New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	// Defer the initial regular poll so tests exercise PullRequestHot in isolation unless
	// they explicitly call Refresh or configure a short PollInterval.
	now := s.opts.Now()
	s.mu.Lock()
	s.lastPoll = now
	s.pollNext = now.Add(opts.PollInterval)
	s.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = s.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return s
}

func waitForDetailEvent(t *testing.T, ch <-chan PullRequestDetailUpdated, slug string, num int) PullRequestDetailUpdated {
	t.Helper()
	timeout := time.NewTimer(5 * time.Second)
	defer timeout.Stop()
	for {
		select {
		case ev := <-ch:
			if ev.Slug == slug && ev.Number == num {
				return ev
			}
		case <-timeout.C:
			t.Fatalf("timed out waiting for PullRequestDetailUpdated(%s#%d)", slug, num)
		}
	}
}

// TestHotPollPendingCITransitions verifies both stages of pending CI fast-polling:
//   - pending check count ticks patch Checks in place, set checksStale, publish
//     PullRequestDetailUpdated, and trigger only checks.graphql (0 PullRequestFull);
//   - settling PENDING -> SUCCESS marks the entry stale, marks s.moved, publishes
//     PullRequestDetailUpdated, and stops hot-polling once settled.
func TestHotPollPendingCITransitions(t *testing.T) {
	ctx := context.Background()
	g, t0 := changeDrivenWorld()
	g.edit("PR_a", func(p *PullRequest) {
		p.UpdatedAt = t0
		p.Checks = CheckRollup{State: RollupPending, Total: 12, Passed: 1, Pending: 11}
	})
	f := (&fakeRunner{}).serve(g)
	b := bus.New()
	detailSub := bus.Subscribe[PullRequestDetailUpdated](b, 32)
	s := startHotStore(t, f, b, nil)

	d, err := s.FullPullRequest(ctx, "o/r", 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if d.PullRequest.Checks.Passed != 1 || d.PullRequest.Checks.Pending != 11 {
		t.Fatalf("initial checks = %+v", d.PullRequest.Checks)
	}
	// Populate Store.PullRequest cache so we can verify hot poll invalidates it via s.moved.
	if _, err := s.PullRequest(ctx, "o/r", 1); err != nil {
		t.Fatal(err)
	}

	// Stage 1: pending check counts tick (1/12 -> 4/12, still PENDING, 0 failures).
	g.edit("PR_a", func(p *PullRequest) {
		p.Checks = CheckRollup{State: RollupPending, Total: 12, Passed: 4, Pending: 8}
	})
	waitForDetailEvent(t, detailSub.C(), "o/r", 1)

	if f.count("PullRequestHot") < 1 {
		t.Fatalf("PullRequestHot calls = %d, want >= 1", f.count("PullRequestHot"))
	}
	if f.count("PullRequestFull") != 1 {
		t.Fatalf("PullRequestFull calls = %d, want 1", f.count("PullRequestFull"))
	}
	e, ok := s.full.entry(fullKey{"o/r", 1})
	if !ok || !e.checksStale || e.stale {
		t.Fatalf("entry after pending tick = {stale:%v checksStale:%v}, want {false true}", e.stale, e.checksStale)
	}
	if e.d.PullRequest.Checks.Passed != 4 || e.d.PullRequest.Checks.Pending != 8 {
		t.Fatalf("patched checks = %+v, want 4 passed / 8 pending", e.d.PullRequest.Checks)
	}

	// Panel re-reads: serves patched counts immediately with Refreshing=true and runs only Checks.
	fullBefore := f.count("PullRequestFull")
	d2, err := s.FullPullRequest(ctx, "o/r", 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if !d2.Refreshing || d2.PullRequest.Checks.Passed != 4 {
		t.Fatalf("re-read after tick = {refreshing:%v passed:%d}, want {true 4}", d2.Refreshing, d2.PullRequest.Checks.Passed)
	}
	waitForDetailEvent(t, detailSub.C(), "o/r", 1)
	if f.count("Checks") < 1 {
		t.Fatalf("Checks calls = %d, want >= 1", f.count("Checks"))
	}
	if f.count("PullRequestFull") != fullBefore {
		t.Fatalf("PullRequestFull calls after pending tick = %d, want %d (checks.graphql only)", f.count("PullRequestFull"), fullBefore)
	}

	// Stage 2: CI settles PENDING -> SUCCESS.
	g.edit("PR_a", func(p *PullRequest) {
		p.Checks = CheckRollup{State: RollupSuccess, Total: 12, Passed: 12}
	})
	waitForDetailEvent(t, detailSub.C(), "o/r", 1)

	e, ok = s.full.entry(fullKey{"o/r", 1})
	if !ok || !e.stale || e.checksStale {
		t.Fatalf("entry after settle = {stale:%v checksStale:%v}, want {true false}", e.stale, e.checksStale)
	}
	if !s.moved.movedSince(fullKey{"o/r", 1}, d.FetchedAt) {
		t.Error("s.moved did not record settled check transition")
	}

	// Panel re-reads and fetches settled FullPullRequest.
	if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
		t.Fatal(err)
	}
	waitForDetailEvent(t, detailSub.C(), "o/r", 1)
	d3, err := s.FullPullRequest(ctx, "o/r", 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if d3.PullRequest.Checks.State != RollupSuccess || d3.Refreshing {
		t.Fatalf("final detail = {state:%s refreshing:%v}, want {SUCCESS false}", d3.PullRequest.Checks.State, d3.Refreshing)
	}

	// Once settled, 0 further PullRequestHot queries should fire.
	hotAfterSettle := f.count("PullRequestHot")
	time.Sleep(100 * time.Millisecond)
	if got := f.count("PullRequestHot"); got != hotAfterSettle {
		t.Fatalf("PullRequestHot fired after PR settled: before=%d after=%d", hotAfterSettle, got)
	}
}

// TestHotPollMergeableResolution verifies that UNKNOWN -> MERGEABLE is detected by
// PullRequestHot even when GitHub does not bump UpdatedAt.
func TestHotPollMergeableResolution(t *testing.T) {
	ctx := context.Background()
	g, _ := changeDrivenWorld()
	g.edit("PR_a", func(p *PullRequest) {
		p.Checks = CheckRollup{State: RollupSuccess, Total: 3, Passed: 3}
		p.Mergeable = MergeableUnknown
		p.MergeStateStatus = "UNKNOWN"
	})
	f := (&fakeRunner{}).serve(g)
	b := bus.New()
	detailSub := bus.Subscribe[PullRequestDetailUpdated](b, 16)
	s := startHotStore(t, f, b, nil)

	d, err := s.FullPullRequest(ctx, "o/r", 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if d.PullRequest.Mergeable != MergeableUnknown {
		t.Fatalf("initial mergeable = %s, want UNKNOWN", d.PullRequest.Mergeable)
	}

	// Resolve mergeability on GitHub WITHOUT touching UpdatedAt.
	g.edit("PR_a", func(p *PullRequest) {
		p.Mergeable = MergeableMergeable
		p.MergeStateStatus = "CLEAN"
	})
	waitForDetailEvent(t, detailSub.C(), "o/r", 1)

	e, ok := s.full.entry(fullKey{"o/r", 1})
	if !ok || !e.stale {
		t.Fatalf("entry after mergeable resolution = {stale:%v ok:%v}, want stale=true", e.stale, ok)
	}
	// Panel re-reads and receives resolved mergeability.
	if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
		t.Fatal(err)
	}
	waitForDetailEvent(t, detailSub.C(), "o/r", 1)
	d2, err := s.FullPullRequest(ctx, "o/r", 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if d2.PullRequest.Mergeable != MergeableMergeable || d2.PullRequest.MergeStateStatus != "CLEAN" {
		t.Fatalf("resolved detail = {%s %s}, want {MERGEABLE CLEAN}", d2.PullRequest.Mergeable, d2.PullRequest.MergeStateStatus)
	}

	// Settled now: 0 further hot polls.
	hotCount := f.count("PullRequestHot")
	time.Sleep(100 * time.Millisecond)
	if got := f.count("PullRequestHot"); got != hotCount {
		t.Fatalf("PullRequestHot after mergeable settled = %d, want %d", got, hotCount)
	}
}

// TestHotPollPostMutationWindow verifies that a local mutation (SetPullRequestDraft /
// patchFull) keeps a previously settled open PR hot for DefaultHotMutateWindow so CI
// spinning up right after the mutation is caught within HotPollInterval.
func TestHotPollPostMutationWindow(t *testing.T) {
	ctx := context.Background()
	g, _ := changeDrivenWorld()
	g.edit("PR_a", func(p *PullRequest) {
		p.Draft = true
		p.Checks = CheckRollup{State: RollupSuccess, Total: 3, Passed: 3}
		p.Mergeable = MergeableMergeable
		p.MergeStateStatus = "DRAFT"
	})
	f := (&fakeRunner{}).serve(g)
	b := bus.New()
	detailSub := bus.Subscribe[PullRequestDetailUpdated](b, 32)
	s := startHotStore(t, f, b, nil)

	// Open settled draft PR: 0 hot polls before mutation.
	if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(80 * time.Millisecond)
	if got := f.count("PullRequestHot"); got != 0 {
		t.Fatalf("PullRequestHot before mutation = %d, want 0", got)
	}

	// Mutate via SetPullRequestDraft (marks ready -> calls patchFull -> stamps mutatedAt).
	if _, err := s.SetPullRequestDraft(ctx, "o/r", 1, false); err != nil {
		t.Fatal(err)
	}
	// Drain the patchFull event.
	waitForDetailEvent(t, detailSub.C(), "o/r", 1)

	// Hot poll must now run even while Checks is still RollupSuccess.
	waitFor(t, "post-mutation hot poll", func() bool { return f.count("PullRequestHot") >= 1 })

	// Simulate CI starting up after the ready-for-review transition.
	g.edit("PR_a", func(p *PullRequest) {
		p.Checks = CheckRollup{State: RollupPending, Total: 4, Passed: 0, Pending: 4}
	})
	waitForDetailEvent(t, detailSub.C(), "o/r", 1)
	if e, ok := s.full.entry(fullKey{"o/r", 1}); !ok || !e.stale {
		t.Fatalf("entry after post-mutation CI start = {stale:%v ok:%v}, want stale=true", e.stale, ok)
	}

	// Unit-check window expiry with a deterministic clock: past DefaultHotMutateWindow,
	// a settled PR is no longer eligible.
	t.Run("window expiry stops eligibility", func(t *testing.T) {
		clk := &testClock{}
		g2, _ := changeDrivenWorld()
		g2.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupSuccess, Total: 3, Passed: 3}
			p.Mergeable = MergeableMergeable
			p.MergeStateStatus = "CLEAN"
		})
		opts := hotTestOptions(t, (&fakeRunner{}).serve(g2), nil, func(o *Options) {
			o.Now = clk.now
			o.HotPollInterval = DefaultHotPollInterval
		})
		s2, err := New(ctx, opts)
		if err != nil {
			t.Fatal(err)
		}
		k := fullKey{"o/r", 1}
		s2.full.put(k, FullPullRequest{PullRequest: *g2.prs["PR_a"], FetchedAt: clk.now()})
		s2.touchHot(k, *g2.prs["PR_a"], true)
		if !s2.hasEligibleHot(clk.now()) {
			t.Fatal("expected PR to be eligible immediately after mutation")
		}
		clk.advance(DefaultHotMutateWindow - time.Second)
		if !s2.hasEligibleHot(clk.now()) {
			t.Fatal("expected PR to remain eligible within DefaultHotMutateWindow")
		}
		clk.advance(2 * time.Second)
		if s2.hasEligibleHot(clk.now()) {
			t.Fatal("expected settled PR to stop being eligible after DefaultHotMutateWindow")
		}
	})
}

// TestHotPollZeroWastedPolls verifies 0 PullRequestHot queries for: no panel open,
// settled open PR, closed/merged PR (and immediate drop on OPEN -> MERGED), expired lease,
// and disabled HotPollInterval (< 0).
func TestHotPollZeroWastedPolls(t *testing.T) {
	ctx := context.Background()

	t.Run("no panel open and settled open PR", func(t *testing.T) {
		g, _ := changeDrivenWorld()
		g.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupSuccess, Total: 2, Passed: 2}
			p.Mergeable = MergeableMergeable
			p.MergeStateStatus = "CLEAN"
		})
		f := (&fakeRunner{}).serve(g)
		s := startHotStore(t, f, nil, nil)
		time.Sleep(80 * time.Millisecond)
		if got := f.count("PullRequestHot"); got != 0 {
			t.Fatalf("with no panel open: PullRequestHot = %d, want 0", got)
		}
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		time.Sleep(80 * time.Millisecond)
		if got := f.count("PullRequestHot"); got != 0 {
			t.Fatalf("with settled open PR: PullRequestHot = %d, want 0", got)
		}
	})

	t.Run("closed or merged PR dropped immediately", func(t *testing.T) {
		g, t0 := changeDrivenWorld()
		g.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupPending, Total: 2, Pending: 2}
		})
		mergedPR := fakePR("PR_merged", "o/r", 2, t0)
		mergedPR.State = PullRequestMerged
		mergedPR.MergedAt = t0
		mergedPR.Checks = CheckRollup{State: RollupPending, Total: 2, Pending: 2}
		g.addPR(mergedPR, sectionMerged)

		f := (&fakeRunner{}).serve(g)
		b := bus.New()
		detailSub := bus.Subscribe[PullRequestDetailUpdated](b, 16)
		s := startHotStore(t, f, b, nil)

		// Opening an already-merged PR never triggers hot polling.
		if _, err := s.FullPullRequest(ctx, "o/r", 2, false); err != nil {
			t.Fatal(err)
		}
		time.Sleep(80 * time.Millisecond)
		if got := f.count("PullRequestHot"); got != 0 {
			t.Fatalf("with merged PR open: PullRequestHot = %d, want 0", got)
		}

		// Opening hot PR #1 starts hot polling; once GitHub merges it, hotPoll detects it,
		// marks stale, drops #1 from hotPRs, and stops sending PullRequestHot.
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		g.edit("PR_a", func(p *PullRequest) {
			p.State = PullRequestMerged
			p.MergedAt = t0.Add(time.Minute)
			p.UpdatedAt = t0.Add(time.Minute)
		})
		waitForDetailEvent(t, detailSub.C(), "o/r", 1)
		if s.hasEligibleHot(s.opts.Now()) {
			t.Fatal("merged PR still reported hot-eligible")
		}
		hotAfterMerge := f.count("PullRequestHot")
		time.Sleep(80 * time.Millisecond)
		if got := f.count("PullRequestHot"); got != hotAfterMerge {
			t.Fatalf("PullRequestHot continued after merge: before=%d after=%d", hotAfterMerge, got)
		}
	})

	t.Run("expired lease produces 0 hot polls", func(t *testing.T) {
		clk := &testClock{}
		g, _ := changeDrivenWorld()
		g.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupPending, Total: 2, Pending: 2}
		})
		opts := hotTestOptions(t, (&fakeRunner{}).serve(g), nil, func(o *Options) {
			o.Now = clk.now
			o.HotPollInterval = DefaultHotPollInterval
		})
		s, err := New(ctx, opts)
		if err != nil {
			t.Fatal(err)
		}
		k := fullKey{"o/r", 1}
		s.full.put(k, FullPullRequest{PullRequest: *g.prs["PR_a"], FetchedAt: clk.now()})
		s.touchHot(k, *g.prs["PR_a"], false)
		if !s.hasEligibleHot(clk.now()) {
			t.Fatal("expected PR to be eligible before lease expiry")
		}
		clk.advance(DefaultHotLease + time.Second)
		if s.hasEligibleHot(clk.now()) {
			t.Fatal("expected PR to be ineligible after DefaultHotLease")
		}
	})

	t.Run("negative HotPollInterval disables hot poll", func(t *testing.T) {
		g, _ := changeDrivenWorld()
		g.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupPending, Total: 2, Pending: 2}
		})
		f := (&fakeRunner{}).serve(g)
		s := startHotStore(t, f, nil, func(o *Options) {
			o.HotPollInterval = -1
		})
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		time.Sleep(80 * time.Millisecond)
		if got := f.count("PullRequestHot"); got != 0 {
			t.Fatalf("PullRequestHot when disabled = %d, want 0", got)
		}
	})
}

// TestHotPollPresenceGating verifies strict PresenceForeground gating: 0 hot polls in
// PresenceBackground or PresenceNone, prompt resumption on PresenceChanged to
// PresenceForeground, and clean stop when dropping back to PresenceBackground.
func TestHotPollPresenceGating(t *testing.T) {
	ctx := context.Background()
	g, _ := changeDrivenWorld()
	g.edit("PR_a", func(p *PullRequest) {
		p.Checks = CheckRollup{State: RollupPending, Total: 3, Passed: 1, Pending: 2}
	})
	f := (&fakeRunner{}).serve(g)
	b := bus.New()
	detailSub := bus.Subscribe[PullRequestDetailUpdated](b, 16)

	var pres atomic.Int32
	pres.Store(int32(PresenceBackground))

	s := startHotStore(t, f, b, func(o *Options) {
		o.Presence = func() Presence { return Presence(pres.Load()) }
	})
	// Mark lastPoll recent so PresenceChanged -> Foreground does not schedule an immediate full Poll.
	s.mu.Lock()
	s.lastPoll = s.opts.Now()
	s.pollNext = s.opts.Now().Add(time.Hour)
	s.mu.Unlock()

	if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if got := f.count("PullRequestHot"); got != 0 {
		t.Fatalf("PullRequestHot in PresenceBackground = %d, want 0", got)
	}

	pres.Store(int32(PresenceNone))
	s.PresenceChanged(PresenceBackground, PresenceNone)
	time.Sleep(80 * time.Millisecond)
	if got := f.count("PullRequestHot"); got != 0 {
		t.Fatalf("PullRequestHot in PresenceNone = %d, want 0", got)
	}

	// Return to PresenceForeground: hot poll must resume and detect CI settling.
	g.edit("PR_a", func(p *PullRequest) {
		p.Checks = CheckRollup{State: RollupSuccess, Total: 3, Passed: 3}
	})
	pres.Store(int32(PresenceForeground))
	s.PresenceChanged(PresenceNone, PresenceForeground)
	waitForDetailEvent(t, detailSub.C(), "o/r", 1)
	if f.count("PullRequestHot") < 1 {
		t.Fatalf("PullRequestHot after returning to foreground = %d, want >= 1", f.count("PullRequestHot"))
	}

	// Re-open with pending checks, then drop to PresenceBackground and verify hot polls stop.
	g.edit("PR_a", func(p *PullRequest) {
		p.Checks = CheckRollup{State: RollupPending, Total: 3, Pending: 3}
	})
	if _, err := s.FullPullRequest(ctx, "o/r", 1, true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "foreground hot poll running", func() bool { return f.count("PullRequestHot") >= 2 })

	pres.Store(int32(PresenceBackground))
	s.PresenceChanged(PresenceForeground, PresenceBackground)
	time.Sleep(40 * time.Millisecond) // allow any in-flight hot poll to finish
	afterDrop := f.count("PullRequestHot")
	time.Sleep(100 * time.Millisecond)
	if got := f.count("PullRequestHot"); got != afterDrop {
		t.Fatalf("PullRequestHot after dropping to background = %d, want %d", got, afterDrop)
	}
}

// TestHotPollPauseAuthAndBudget verifies that rate-limit pauses, auth failures, and
// low rate-limit budget stop hot polling cleanly without overriding or clearing pauses.
func TestHotPollPauseAuthAndBudget(t *testing.T) {
	ctx := context.Background()

	t.Run("rate limit pause stops hot poll", func(t *testing.T) {
		g, _ := changeDrivenWorld()
		g.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupPending, Total: 2, Pending: 2}
		})
		f := (&fakeRunner{}).serve(g)
		g.failNext("PullRequestHot", &RateLimitError{Secondary: true, RetryAfter: time.Hour})
		s := startHotStore(t, f, nil, nil)
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "first hot poll hit rate limit", func() bool { return f.count("PullRequestHot") >= 1 })
		time.Sleep(100 * time.Millisecond)
		if got := f.count("PullRequestHot"); got != 1 {
			t.Fatalf("PullRequestHot while rate-limited = %d, want 1", got)
		}
		s.mu.Lock()
		paused := s.pausedLocked() != nil
		s.mu.Unlock()
		if !paused {
			t.Fatal("expected store to remain paused after rate-limited hot poll")
		}
	})

	t.Run("auth failure stops hot poll", func(t *testing.T) {
		g, _ := changeDrivenWorld()
		g.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupPending, Total: 2, Pending: 2}
		})
		f := (&fakeRunner{}).serve(g)
		f.auth = func() (AuthStatus, error) { return AuthStatus{LoggedIn: false, Error: "bad token"}, nil }
		g.failNext("PullRequestHot", fmt.Errorf("%w: bad credentials", ErrNotAuthenticated))
		s := startHotStore(t, f, nil, func(o *Options) {
			o.AuthRetry = time.Hour
		})
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "authBad set by hot poll", func() bool {
			s.mu.Lock()
			defer s.mu.Unlock()
			return s.authBad
		})
		time.Sleep(100 * time.Millisecond)
		if got := f.count("PullRequestHot"); got != 1 {
			t.Fatalf("PullRequestHot while authBad = %d, want 1", got)
		}
	})

	t.Run("low budget pauses hot poll", func(t *testing.T) {
		g, _ := changeDrivenWorld()
		g.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupPending, Total: 2, Pending: 2}
		})
		f := &fakeRunner{}
		f.setDoc(func(op, doc string, vars map[string]any) (json.RawMessage, error) {
			raw, err := g.respond(op, doc, vars)
			if err != nil || op != "PullRequestHot" {
				return raw, err
			}
			var m map[string]any
			if uErr := json.Unmarshal(raw, &m); uErr != nil {
				return nil, uErr
			}
			m["rateLimit"] = map[string]any{
				"limit":     5000,
				"cost":      1,
				"remaining": 10, // well below DefaultMinRemaining (200)
				"resetAt":   time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
			}
			b, mErr := json.Marshal(m)
			return b, mErr
		})
		s := startHotStore(t, f, nil, nil)
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "low budget hot poll", func() bool { return f.count("PullRequestHot") >= 1 })
		time.Sleep(100 * time.Millisecond)
		if got := f.count("PullRequestHot"); got != 1 {
			t.Fatalf("PullRequestHot after low budget pause = %d, want 1", got)
		}
	})
}

// TestHotPollAntiDuplication verifies:
//   - when a regular poll is due within min(HotPollInterval/3, 3s), jobPoll is chosen
//     instead of jobHotPoll;
//   - after a regular poll completes, hotNext is reset to now + HotPollInterval.
func TestHotPollAntiDuplication(t *testing.T) {
	ctx := context.Background()

	t.Run("skips hot poll when full poll is imminent", func(t *testing.T) {
		clk := &testClock{}
		opts := hotTestOptions(t, &fakeRunner{}, nil, func(o *Options) {
			o.Now = clk.now
			o.MinGap = time.Second
			o.HotPollInterval = 15 * time.Second
		})
		s, err := New(ctx, opts)
		if err != nil {
			t.Fatal(err)
		}
		now := clk.now()
		s.mu.Lock()
		// Hot poll is due now, full poll is due in 2s (<= 3s skip window): must choose jobPoll.
		s.hotNext = now
		s.pollNext = now.Add(2 * time.Second)
		j, at := s.nextScheduledLocked(now, PresenceForeground, true)
		if j.kind != jobPoll || !at.Equal(s.pollNext) {
			s.mu.Unlock()
			t.Fatalf("poll in 2s: got kind=%v at=%v, want jobPoll at %v", j.kind, at, s.pollNext)
		}
		// Full poll is due in 5s (> 3s skip window): must choose jobHotPoll.
		s.pollNext = now.Add(5 * time.Second)
		j, at = s.nextScheduledLocked(now, PresenceForeground, true)
		if j.kind != jobHotPoll || !at.Equal(s.hotNext) {
			s.mu.Unlock()
			t.Fatalf("poll in 5s: got kind=%v at=%v, want jobHotPoll at %v", j.kind, at, s.hotNext)
		}
		s.mu.Unlock()
	})

	t.Run("full poll resets hotNext to now + HotPollInterval", func(t *testing.T) {
		clk := &testClock{}
		g, _ := changeDrivenWorld()
		g.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupPending, Total: 2, Pending: 2}
		})
		f := (&fakeRunner{}).serve(g)
		b := bus.New()
		polled := bus.Subscribe[Polled](b, 16)
		s := startHotStore(t, f, b, func(o *Options) {
			o.Now = clk.now
			o.MinGap = time.Millisecond
			o.HotPollInterval = 15 * time.Second
			o.PollInterval = time.Hour
		})
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		// Advance clock 10s so hotNext is only 5s away, then run a full poll.
		clk.advance(10 * time.Second)
		pollStart := clk.now()
		if err := s.Refresh(ctx, ""); err != nil {
			t.Fatal(err)
		}
		<-polled.C()
		pollEnd := clk.now()

		// Regular poll must have pushed hotNext forward to [pollStart+15s, pollEnd+15s] (not +5s).
		s.mu.Lock()
		gotHotNext := s.hotNext
		s.mu.Unlock()
		if gotHotNext.Before(pollStart.Add(15*time.Second)) || gotHotNext.After(pollEnd.Add(15*time.Second)) {
			t.Fatalf("hotNext after regular poll = %v, want in [%v, %v]",
				gotHotNext, pollStart.Add(15*time.Second), pollEnd.Add(15*time.Second))
		}
		if got := f.count("PullRequestHot"); got != 0 {
			t.Fatalf("PullRequestHot fired during regular poll reset: got %d, want 0", got)
		}
	})

	t.Run("resolved to UNKNOWN mergeability regression does not stale entry", func(t *testing.T) {
		var c fullCache
		now := time.Now()
		k := fullKey{"o/r", 1}
		d := FullPullRequest{
			PullRequest: PullRequest{
				ID:               "PR_a",
				Repo:             "o/r",
				Number:           1,
				State:            PullRequestOpen,
				HeadSHA:          "sha1",
				UpdatedAt:        now,
				Checks:           CheckRollup{State: RollupSuccess, Total: 1, Passed: 1},
				Mergeable:        MergeableMergeable,
				MergeStateStatus: "CLEAN",
			},
			FetchedAt: now,
		}
		c.putWithSeq(k, d, 5)
		regressed := hotNode{
			fp: prFingerprint{
				ID:        "PR_a",
				Repo:      "o/r",
				Number:    1,
				State:     PullRequestOpen,
				HeadSHA:   "sha1",
				UpdatedAt: now,
				Checks:    CheckRollup{State: RollupSuccess, Total: 1, Passed: 1},
			},
			Mergeable:        MergeableUnknown,
			MergeStateStatus: "UNKNOWN",
		}
		changes, closed := c.applyHotAt([]hotNode{regressed}, 10, now.Add(time.Second))
		if len(changes) != 0 || len(closed) != 0 {
			t.Fatalf("resolved->UNKNOWN regression produced changes=%v closed=%v, want none", changes, closed)
		}
		e, ok := c.entry(k)
		if !ok || e.stale || e.checksStale {
			t.Fatalf("entry = %+v (ok=%v), want fresh and not stale", e, ok)
		}
	})

	t.Run("null node drops hot lease so deleted PR is not re-polled", func(t *testing.T) {
		clk := &testClock{}
		g, _ := changeDrivenWorld()
		g.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupPending, Total: 2, Pending: 2}
		})
		f := (&fakeRunner{}).serve(g)
		s := startHotStore(t, f, nil, func(o *Options) {
			o.Now = clk.now
			o.HotPollInterval = DefaultHotPollInterval
		})
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		targets := s.eligibleHotTargets(clk.now())
		if len(targets) != 1 {
			t.Fatalf("eligible targets before null node = %v, want 1", targets)
		}
		// Simulate complete response returning [null] (decoded as 0 nodes).
		s.applyHotPoll(targets, nil, true, 10, clk.now(), clk.now())
		if got := s.eligibleHotIDs(clk.now()); len(got) != 0 {
			t.Fatalf("eligible IDs after null node = %v, want empty", got)
		}
	})
}

// TestHotPollCapMaxHotPRs verifies that at most maxHotPRs (8) IDs are sent per
// PullRequestHot batch, ordered most recently touched first.
func TestHotPollCapMaxHotPRs(t *testing.T) {
	ctx := context.Background()
	clk := &testClock{}
	g := newFakeGitHub()
	t0 := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	for i := 1; i <= 12; i++ {
		id := fmt.Sprintf("PR_hot_%d", i)
		p := fakePR(id, "o/r", i, t0)
		p.Checks = CheckRollup{State: RollupPending, Total: 2, Pending: 2}
		g.addPR(p)
	}
	f := (&fakeRunner{}).serve(g)
	s := startHotStore(t, f, nil, func(o *Options) {
		o.Now = clk.now
		o.HotPollInterval = DefaultHotPollInterval
	})

	// Touch #1..#12 sequentially, advancing clock 1s each time, then re-touch #2 last.
	for i := 1; i <= 12; i++ {
		clk.advance(time.Second)
		if _, err := s.FullPullRequest(ctx, "o/r", i, false); err != nil {
			t.Fatal(err)
		}
	}
	clk.advance(time.Second)
	if _, err := s.FullPullRequest(ctx, "o/r", 2, false); err != nil {
		t.Fatal(err)
	}

	gotIDs := s.eligibleHotIDs(clk.now())
	wantIDs := []string{"PR_hot_2", "PR_hot_12", "PR_hot_11", "PR_hot_10", "PR_hot_9", "PR_hot_8", "PR_hot_7", "PR_hot_6"}
	if !slices.Equal(gotIDs, wantIDs) {
		t.Fatalf("eligibleHotIDs = %v, want %v", gotIDs, wantIDs)
	}

	// Advance past HotPollInterval, nudge, and verify the wire PullRequestHot vars["ids"].
	clk.advance(DefaultHotPollInterval + time.Second)
	s.nudge()
	waitFor(t, "capped PullRequestHot", func() bool { return f.count("PullRequestHot") >= 1 })
	calls, _ := f.snapshot()
	var sentIDs []string
	for _, c := range calls {
		if c.op == "PullRequestHot" {
			sentIDs = anyStrings(c.vars["ids"])
			break
		}
	}
	if !slices.Equal(sentIDs, wantIDs) {
		t.Fatalf("wire PullRequestHot ids = %v, want %v", sentIDs, wantIDs)
	}
}

// TestHotPollReadLaneCausalityAndYielding verifies:
//   - a user-waited read can overlap on the read lane while PullRequestHot is in flight,
//     and an older PullRequestHot response (fpSeq < fetchSeq) never falsely stales the
//     fresher read-lane FullPullRequest;
//   - with read lane disabled (single-lane fallback), PullRequestHot yields to user-waited
//     clicks via admit/yield.go and never consumes gapAllowance tokens.
func TestHotPollReadLaneCausalityAndYielding(t *testing.T) {
	ctx := context.Background()

	t.Run("read-lane overlap and causality", func(t *testing.T) {
		g, t0 := changeDrivenWorld()
		g.edit("PR_a", func(p *PullRequest) {
			p.UpdatedAt = t0
			p.Checks = CheckRollup{State: RollupPending, Total: 2, Pending: 2}
		})
		r := &readLaneRunner{g: g}
		s := startHotStore(t, r, nil, func(o *Options) {
			o.HotPollInterval = 30 * time.Millisecond
		})
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}

		// Hold PullRequestHot AFTER fakeGitHub builds its PENDING response so its fpSeq
		// is strictly older than the concurrent read-lane FullPullRequest.
		hotHeld, hotRelease := make(chan struct{}), make(chan struct{})
		var holdOnce, relOnce sync.Once
		defer relOnce.Do(func() { close(hotRelease) })
		r.mu.Lock()
		r.afterOp = func(_ context.Context, op string, data json.RawMessage, err error) (json.RawMessage, error) {
			if op == "PullRequestHot" {
				holdOnce.Do(func() {
					close(hotHeld)
					<-hotRelease
				})
			}
			return data, err
		}
		r.mu.Unlock()

		<-hotHeld

		// Advance GitHub and issue a user-waited FullPullRequest while PullRequestHot is held.
		g.edit("PR_a", func(p *PullRequest) {
			p.UpdatedAt = t0.Add(time.Hour)
			p.Checks = CheckRollup{State: RollupSuccess, Total: 2, Passed: 2}
		})
		d, err := s.FullPullRequest(ctx, "o/r", 1, true)
		if err != nil {
			t.Fatal(err)
		}
		if d.PullRequest.Checks.State != RollupSuccess {
			t.Fatalf("read-lane fetch state = %s, want SUCCESS", d.PullRequest.Checks.State)
		}
		_, maxInflight, _, _ := r.stats()
		if maxInflight < 2 {
			t.Errorf("maxInflight = %d, want >= 2 (read lane overlapped PullRequestHot)", maxInflight)
		}

		// Release older PullRequestHot and ensure it does NOT stale the fresher entry.
		relOnce.Do(func() { close(hotRelease) })
		settleWorker(t, s)
		e, ok := s.full.entry(fullKey{"o/r", 1})
		if !ok || e.stale || e.checksStale {
			t.Fatalf("fresher read-lane entry was staled by older PullRequestHot: %+v", e)
		}
	})

	t.Run("yields to user-waited click and spends 0 allowance tokens", func(t *testing.T) {
		g, t0 := changeDrivenWorld()
		g.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupPending, Total: 2, Pending: 2}
		})
		g.addPR(fakePR("PR_b", "o/r", 2, t0), sectionAuthored)
		f := (&fakeRunner{}).serve(g)
		s := startHotStore(t, f, nil, func(o *Options) {
			o.MinGap = 60 * time.Millisecond
			o.UserGap = 5 * time.Millisecond
			o.HotPollInterval = 60 * time.Millisecond
			o.disableReadLane = true
		})
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		// Record allowance before hot poll runs.
		waitFor(t, "hot poll ran", func() bool { return f.count("PullRequestHot") >= 1 })
		s.mu.Lock()
		owedBefore := s.allowance.owed
		s.mu.Unlock()

		// Confirm a second hot poll spends 0 allowance tokens.
		waitFor(t, "second hot poll ran", func() bool { return f.count("PullRequestHot") >= 2 })
		s.mu.Lock()
		owedAfter := s.allowance.owed
		s.mu.Unlock()
		if !owedAfter.Equal(owedBefore) {
			t.Fatalf("hot poll modified gapAllowance: before=%v after=%v", owedBefore, owedAfter)
		}

		// Verify jobHotPoll is strictly ineligible for the read lane.
		if (&job{kind: jobHotPoll, read: true, waiters: []chan jobResult{make(chan jobResult, 1)}}).readLaneEligible() {
			t.Fatal("jobHotPoll must never be readLaneEligible")
		}
	})
}

func TestDecodeHotNodesIgnoresNullAndNonPullRequest(t *testing.T) {
	raw := []byte(`{
		"nodes": [
			null,
			{"__typename": "Issue", "id": "I_1", "number": 1},
			{
				"__typename": "PullRequest",
				"id": "PR_1",
				"number": 42,
				"updatedAt": "2026-11-25T10:00:00Z",
				"state": "OPEN",
				"headRefOid": "abc123",
				"isCrossRepository": false,
				"author": {"login": "octocat"},
				"repository": {"nameWithOwner": "O/R"},
				"isDraft": true,
				"mergeable": "MERGEABLE",
				"mergeStateStatus": "CLEAN",
				"statusCheckRollup": {
					"state": "SUCCESS",
					"contexts": {
						"checkRunCount": 2,
						"checkRunCountsByState": [{"state": "SUCCESS", "count": 2}],
						"statusContextCount": 0,
						"statusContextCountsByState": []
					}
				}
			}
		]
	}`)
	nodes, err := decodeHotNodes(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 1 {
		t.Fatalf("len(nodes) = %d, want 1", len(nodes))
	}
	got := nodes[0]
	if got.fp.ID != "PR_1" || got.fp.Repo != "o/r" || got.fp.Number != 42 || !got.Draft ||
		got.Mergeable != MergeableMergeable || got.MergeStateStatus != "CLEAN" ||
		got.fp.Checks.State != RollupSuccess || got.fp.Checks.Passed != 2 {
		t.Fatalf("decoded node = %+v", got)
	}
	if _, err := decodeHotNodes([]byte(`{bad`)); err == nil || !errors.Is(err, err) {
		t.Fatalf("invalid json: want error, got %v", err)
	}
}
