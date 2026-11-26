package gh

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// checksTickWorld is a tracked repository whose PR #1 has CI running (1 of 3 checks
// passed, merge BLOCKED on it), fetched once, then one poll later a pending tick: the
// entry is checksStale, so the next stale-first read refreshes only the checks.
func checksTickWorld(t *testing.T, r Runner, g *fakeGitHub, mutate func(*Options)) (*Store, *testClock, *bus.Subscription[PullRequestDetailUpdated]) {
	t.Helper()
	ctx := context.Background()
	b := bus.New()
	events := bus.Subscribe[PullRequestDetailUpdated](b, 64)
	clk := &testClock{}
	opts := testOptions(openTestDB(t), r, b)
	opts.Now = clk.now
	opts.DetailTTL = time.Hour
	if mutate != nil {
		mutate(&opts)
	}
	s := startStore(t, opts)
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	if err := s.Refresh(ctx, "o/any"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
		t.Fatal(err)
	}
	clk.advance(30 * time.Second)
	g.edit("PR_a", func(p *PullRequest) {
		p.Checks = CheckRollup{State: RollupPending, Total: 3, Passed: 2, Pending: 1}
	})
	if err := s.Refresh(ctx, "o/any"); err != nil {
		t.Fatal(err)
	}
	if e, _ := s.full.entry(fullKey{"o/r", 1}); !e.checksStale || e.stale {
		t.Fatalf("setup: entry after pending tick = {stale:%v checksStale:%v}, want {false true}", e.stale, e.checksStale)
	}
	drain(events)
	return s, clk, events
}

func pendingCIWorld() *fakeGitHub {
	g, _ := changeDrivenWorld()
	g.edit("PR_a", func(p *PullRequest) {
		p.Checks = CheckRollup{State: RollupPending, Total: 3, Passed: 1, Pending: 2}
		p.MergeStateStatus = "BLOCKED"
	})
	return g
}

// readSettled reads #1 as an open panel does, and once more after the refresh it
// queued lands.
func readSettled(t *testing.T, s *Store) FullPullRequest {
	t.Helper()
	d, err := s.FullPullRequest(context.Background(), "o/r", 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if d.Refreshing {
		settleWorker(t, s)
		if d, err = s.FullPullRequest(context.Background(), "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
	}
	return d
}

// CI settles between the poll that saw a pending tick and the checks-only refresh that
// tick queued: the refresh sees SUCCESS, and GitHub's merge state moved BLOCKED ->
// CLEAN without bumping updatedAt. The next poll's fingerprint then matches the entry,
// so nothing but a full fetch would ever bring CLEAN in; the panel must not show green
// checks next to a BLOCKED merge.
func TestChecksOnlyRefreshThatSeesCISettleRefreshesMergeState(t *testing.T) {
	g := pendingCIWorld()
	f := (&fakeRunner{}).serve(g)
	s, _, _ := checksTickWorld(t, f, g, nil)
	g.edit("PR_a", func(p *PullRequest) {
		p.Checks = CheckRollup{State: RollupSuccess, Total: 3, Passed: 3}
		p.MergeStateStatus = "CLEAN"
	})
	readSettled(t, s)
	if err := s.Refresh(context.Background(), "o/any"); err != nil {
		t.Fatal(err)
	}
	d := readSettled(t, s)
	if d.PullRequest.Checks.State != RollupSuccess || d.PullRequest.MergeStateStatus != "CLEAN" {
		t.Fatalf("after CI settled: checks %s, merge state %s; want SUCCESS, CLEAN",
			d.PullRequest.Checks.State, d.PullRequest.MergeStateStatus)
	}
}

// A checks-only refresh brings in checks only: it must not make the rest of the
// detail (merge state after the base moved, review threads, comments) look as fresh
// as the checks, or the age rule never refetches it while CI keeps ticking.
func TestChecksOnlyRefreshKeepsDetailAge(t *testing.T) {
	ctx := context.Background()
	g := pendingCIWorld()
	f := (&fakeRunner{}).serve(g)
	s, clk, _ := checksTickWorld(t, f, g, func(o *Options) { o.PollInterval = 10 * time.Minute })
	k := fullKey{"o/r", 1}
	before, _ := s.full.entry(k)
	readSettled(t, s)
	after, _ := s.full.entry(k)
	if !after.d.FetchedAt.Equal(before.d.FetchedAt) {
		t.Fatalf("checks-only refresh moved FetchedAt %v -> %v; want it kept", before.d.FetchedAt, after.d.FetchedAt)
	}

	// The base branch moves: BLOCKED -> BEHIND, which no fingerprint sees. CI keeps
	// ticking every 2 minutes for 30 minutes; the detail is refetched once it is older
	// than the age limit, not postponed by every tick.
	g.edit("PR_a", func(p *PullRequest) { p.MergeStateStatus = "BEHIND" })
	fullBefore := f.count("PullRequestFull")
	for i := 0; i < 15; i++ {
		clk.advance(2 * time.Minute)
		g.edit("PR_a", func(p *PullRequest) {
			p.Checks = CheckRollup{State: RollupPending, Total: 100, Passed: 3 + i, Pending: 97 - i}
		})
		if err := s.Refresh(ctx, "o/any"); err != nil {
			t.Fatal(err)
		}
		readSettled(t, s)
	}
	d := readSettled(t, s)
	if d.PullRequest.MergeStateStatus != "BEHIND" {
		t.Fatalf("after 30 minutes of pending ticks: merge state %s, want BEHIND (PullRequestFull sent %d)",
			d.PullRequest.MergeStateStatus, f.count("PullRequestFull")-fullBefore)
	}
	t.Logf("30 minutes of pending ticks: %d PullRequestFull, %d Checks", f.count("PullRequestFull")-fullBefore, f.count("Checks"))
	// Poll interval 10 minutes: the whole detail is refetched about every 10 minutes
	// (age rule); every other tick stays checks-only.
	if n := f.count("PullRequestFull") - fullBefore; n < 2 || n > 4 {
		t.Fatalf("PullRequestFull over 30 minutes of pending ticks = %d, want 2..4", n)
	}
}

// A background checks-only refresh started from the entry as it was must not throw
// away a full detail a read-lane refresh fetched meanwhile, whichever lands first. The
// read-lane refresh goes out first (lower request sequence) while the primary worker
// is inside a poll; the checks-only refresh starts on the primary after the poll.
func TestChecksOnlyRefreshDoesNotReplaceConcurrentFullFetch(t *testing.T) {
	for _, checksFirst := range []bool{true, false} {
		name := "full lands first"
		if checksFirst {
			name = "checks-only lands first"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			g := pendingCIWorld()
			r := &readLaneRunner{g: g}
			s, _, _ := checksTickWorld(t, r, g, nil)
			g.edit("PR_a", func(p *PullRequest) {
				p.Title = "renamed"
				p.MergeStateStatus = "BEHIND"
			})

			held := map[string]chan struct{}{"Poll": make(chan struct{}), "PullRequestFull": make(chan struct{}), "Checks": make(chan struct{})}
			release := map[string]chan struct{}{"Poll": make(chan struct{}), "PullRequestFull": make(chan struct{}), "Checks": make(chan struct{})}
			var once sync.Map
			releaseAll := sync.OnceFunc(func() {
				for op, ch := range release {
					if _, done := once.LoadOrStore("rel"+op, true); !done {
						close(ch)
					}
				}
			})
			defer releaseAll()
			let := func(op string) {
				if _, done := once.LoadOrStore("rel"+op, true); !done {
					close(release[op])
				}
			}
			r.mu.Lock()
			r.afterOp = func(_ context.Context, op string, data json.RawMessage, err error) (json.RawMessage, error) {
				if h, ok := held[op]; ok {
					if _, done := once.LoadOrStore("held"+op, true); !done {
						close(h)
						<-release[op]
					}
				}
				return data, err
			}
			r.mu.Unlock()

			go func() { _ = s.Refresh(ctx, "o/any") }()
			<-held["Poll"]
			refreshed := make(chan FullPullRequest, 1)
			go func() {
				d, err := s.FullPullRequest(ctx, "o/r", 1, true)
				if err != nil {
					t.Error(err)
				}
				refreshed <- d
			}()
			<-held["PullRequestFull"]
			if d, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil || !d.Refreshing {
				t.Fatalf("stale-first read: refreshing=%v err=%v", d.Refreshing, err)
			}
			let("Poll")
			<-held["Checks"]
			// settleWorker queues a write, which would wait for the held read lane.
			checksLanded := func() {
				waitFor(t, "checks-only refresh landed", func() bool {
					e, _ := s.full.entry(fullKey{"o/r", 1})
					return !e.checksStale
				})
			}
			if checksFirst {
				let("Checks")
				checksLanded()
				let("PullRequestFull")
				<-refreshed
			} else {
				let("PullRequestFull")
				<-refreshed
				let("Checks")
				settleWorker(t, s)
			}
			e, _ := s.full.entry(fullKey{"o/r", 1})
			if e.d.PullRequest.Title != "renamed" || e.d.PullRequest.MergeStateStatus != "BEHIND" {
				t.Fatalf("cached after both landed: title %q, merge state %s; want renamed, BEHIND",
					e.d.PullRequest.Title, e.d.PullRequest.MergeStateStatus)
			}
		})
	}
}

// A refresh someone waits for (refresh=true) that coalesces with a queued background
// refresh of the same pull request fetches the whole detail, whichever was queued first.
func TestWaitedRefreshCoalescedWithBackgroundFetchesFull(t *testing.T) {
	for _, waitedFirst := range []bool{false, true} {
		name := "background queued first"
		if waitedFirst {
			name = "waited refresh queued first"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			g := pendingCIWorld()
			f := (&fakeRunner{}).serve(g)
			s, _, _ := checksTickWorld(t, f, g, func(o *Options) { o.disableReadLane = true })
			g.edit("PR_a", func(p *PullRequest) { p.MergeStateStatus = "BEHIND" })

			// Hold the worker so both reads find each other in the queue.
			started, release := make(chan struct{}), make(chan struct{})
			if err := s.submitBackground(&job{kind: jobFunc, id: "block", run: func(context.Context) (any, error) {
				close(started)
				<-release
				return nil, nil
			}}); err != nil {
				t.Fatal(err)
			}
			<-started
			queued := func() int {
				s.mu.Lock()
				defer s.mu.Unlock()
				return len(s.queue)
			}
			refreshed := make(chan FullPullRequest, 1)
			waited := func() {
				go func() {
					d, err := s.FullPullRequest(ctx, "o/r", 1, true)
					if err != nil {
						t.Error(err)
					}
					refreshed <- d
				}()
				waitFor(t, "waited refresh queued", func() bool { return queued() == 1 })
			}
			background := func() {
				if d, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil || !d.Refreshing {
					t.Fatalf("stale-first read: refreshing=%v err=%v", d.Refreshing, err)
				}
			}
			if waitedFirst {
				waited()
				background()
			} else {
				background()
				waited()
			}
			if n := queued(); n != 1 {
				t.Fatalf("queued jobs = %d, want 1 (coalesced)", n)
			}
			fullBefore := f.count("PullRequestFull")
			close(release)
			d := <-refreshed
			if d.PullRequest.MergeStateStatus != "BEHIND" || f.count("PullRequestFull") != fullBefore+1 {
				t.Fatalf("refresh=true: merge state %s, PullRequestFull sent %d; want BEHIND, 1",
					d.PullRequest.MergeStateStatus, f.count("PullRequestFull")-fullBefore)
			}
		})
	}
}
