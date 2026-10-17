package gh

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

func TestFullCacheEvictsLeastRecentlyFetched(t *testing.T) {
	var c fullCache
	t0 := time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC)
	key := func(i int) fullKey { return fullKey{"o/r", i} }
	for i := 1; i <= fullCacheMax; i++ {
		c.put(key(i), FullPullRequest{FetchedAt: t0.Add(time.Duration(i) * time.Minute)})
	}
	if _, _, ok := c.get(key(1)); !ok || len(c.m) != fullCacheMax {
		t.Fatalf("at the cap: %d entries", len(c.m))
	}
	// One more evicts the least recently fetched (#1).
	c.put(key(fullCacheMax+1), FullPullRequest{FetchedAt: t0.Add(time.Hour * 2)})
	if _, _, ok := c.get(key(1)); ok || len(c.m) != fullCacheMax {
		t.Errorf("#1 kept or size %d", len(c.m))
	}
	// The entry being stored is never the one evicted, even when it is the oldest.
	c.put(key(100), FullPullRequest{FetchedAt: t0})
	if _, _, ok := c.get(key(100)); !ok {
		t.Error("the new entry was evicted")
	}
	if _, _, ok := c.get(key(2)); ok || len(c.m) != fullCacheMax {
		t.Errorf("#2 (now the oldest other) kept or size %d", len(c.m))
	}
}

func TestFullCacheAdopt(t *testing.T) {
	k := fullKey{"o/r", 1}
	fresh := FullPullRequest{Body: "fetched"}
	row := FullPullRequest{Body: "from sqlite"}

	var c fullCache
	if e := c.adopt(k, row); e.d.Body != "from sqlite" || !e.stale || !e.confirmed.IsZero() {
		t.Errorf("adopt into empty = %q stale %v confirmed %v, want the row, stale, unconfirmed", e.d.Body, e.stale, e.confirmed)
	}
	c.put(k, fresh)
	if e := c.adopt(k, row); e.d.Body != "fetched" || e.stale {
		t.Errorf("adopt over a fetched entry = %q stale %v, want it kept", e.d.Body, e.stale)
	}

	// Check and insert are one step: a fetch storing its result concurrently is never
	// overwritten by the older SQLite row.
	for i := range 500 {
		var c fullCache
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); c.adopt(k, row) }()
		go func() { defer wg.Done(); c.put(k, fresh) }()
		wg.Wait()
		if d, _, _ := c.get(k); d.Body != "fetched" {
			t.Fatalf("iteration %d: the SQLite row replaced a fetched entry", i)
		}
	}
}

// A row read back from SQLite may predate polls that would have marked it stale (it was
// evicted from memory, or the daemon was down), so the first read fetches.
func TestFullPullRequestSQLiteRowStartsStale(t *testing.T) {
	g, _ := changeDrivenWorld()
	g.setBody("PR_a", "v1")
	db := openTestDB(t)
	ctx := context.Background()
	s1 := startStore(t, testOptions(db, (&fakeRunner{}).serve(g), nil))
	if d, err := s1.FullPullRequest(ctx, "o/r", 1, false); err != nil || d.Body != "v1" {
		t.Fatalf("first store: %q, %v", d.Body, err)
	}

	g.setBody("PR_a", "v2") // changed while the second store had it only in SQLite
	f2 := (&fakeRunner{}).serve(g)
	s2 := startStore(t, testOptions(db, f2, nil))
	d, err := s2.FullPullRequest(ctx, "o/r", 1, false)
	if err != nil || d.Body != "v2" || f2.count("PullRequestFull") != 1 {
		t.Errorf("after reload: body %q, err %v, fetches %d; want v2 fetched once", d.Body, err, f2.count("PullRequestFull"))
	}
	if _, err := s2.FullPullRequest(ctx, "o/r", 1, false); err != nil || f2.count("PullRequestFull") != 1 {
		t.Errorf("second read fetched again (%d) or failed: %v", f2.count("PullRequestFull"), err)
	}
}

// Jobs coalesce only while queued. A read submitted while the same fetch is running
// gets that fetch's result instead of sending a second request.
func TestFullPullRequestReusesInFlightFetch(t *testing.T) {
	g, _ := changeDrivenWorld()
	gate := make(chan struct{})
	var once sync.Once
	f := &fakeRunner{}
	f.setDoc(func(op, doc string, vars map[string]any) (json.RawMessage, error) {
		if op == "PullRequestFull" {
			once.Do(func() { <-gate })
		}
		return g.respond(op, doc, vars)
	})
	s := startStore(t, testOptions(openTestDB(t), f, nil))
	type result struct {
		d   FullPullRequest
		err error
	}
	read := func(refresh bool) chan result {
		ch := make(chan result, 1)
		go func() {
			d, err := s.FullPullRequest(context.Background(), "o/r", 1, refresh)
			ch <- result{d, err}
		}()
		return ch
	}
	first := read(false)
	waitFor(t, "the first fetch in flight", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.inflight == 1
	})
	second := read(true) // even a refresh: the running fetch started after it was asked for
	waitFor(t, "the second read queued", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.queue) == 1
	})
	close(gate)
	a, b := <-first, <-second
	if a.err != nil || b.err != nil || !a.d.FetchedAt.Equal(b.d.FetchedAt) {
		t.Errorf("results: %v %v, fetched %v vs %v", a.err, b.err, a.d.FetchedAt, b.d.FetchedAt)
	}
	if n := f.count("PullRequestFull"); n != 1 {
		t.Errorf("fetches = %d, want 1", n)
	}
	// A refresh asked for after that fetch finished does fetch.
	if r := <-read(true); r.err != nil || f.count("PullRequestFull") != 2 {
		t.Errorf("later refresh: %v, fetches %d", r.err, f.count("PullRequestFull"))
	}
}

func TestFullEntryServes(t *testing.T) {
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	const interval = time.Minute
	entry := func(state PullRequestState, age time.Duration, confirmedAgo time.Duration, stale bool) fullEntry {
		e := fullEntry{d: FullPullRequest{PullRequest: PullRequest{State: state}, FetchedAt: now.Add(-age)}, stale: stale}
		if confirmedAgo >= 0 {
			e.confirmed = now.Add(-confirmedAgo)
		}
		return e
	}
	const never = -1
	tests := []struct {
		name string
		e    fullEntry
		want bool
	}{
		{"open, younger than the interval", entry(PullRequestOpen, 30*time.Second, never, false), true},
		{"open, past the interval, never confirmed (uncovered)", entry(PullRequestOpen, 61*time.Second, never, false), false},
		{"open, past the interval, confirmed just now", entry(PullRequestOpen, 5*time.Minute, 0, false), true},
		{"open, confirmed within the window (interval plus half)", entry(PullRequestOpen, 5*time.Minute, 80*time.Second, false), true},
		{"open, confirmation past the window", entry(PullRequestOpen, 5*time.Minute, 90*time.Second, false), false},
		{"open, confirmed but older than confirmedMaxAge", entry(PullRequestOpen, confirmedMaxAge, 0, false), false},
		{"open, stale though young and confirmed", entry(PullRequestOpen, time.Second, 0, true), false},
		{"merged, past the interval, inside closedDetailTTL", entry(PullRequestMerged, 9*time.Minute, never, false), true},
		{"merged, past closedDetailTTL, never confirmed", entry(PullRequestMerged, closedDetailTTL, never, false), false},
		{"closed, inside closedDetailTTL", entry(PullRequestClosed, 9*time.Minute, never, false), true},
		{"closed, past closedDetailTTL", entry(PullRequestClosed, 11*time.Minute, never, false), false},
		{"merged, stale inside closedDetailTTL", entry(PullRequestMerged, time.Minute, never, true), false},
		{"merged, confirmed but past confirmedMaxAge", entry(PullRequestMerged, 11*time.Minute, 0, false), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.e.serves(now, interval); got != tt.want {
				t.Errorf("serves = %v, want %v", got, tt.want)
			}
		})
	}

	// A poll interval longer than closedDetailTTL stays the closed limit too.
	long := entry(PullRequestMerged, 15*time.Minute, never, false)
	if !long.serves(now, 20*time.Minute) {
		t.Error("merged under a 20 minute interval: refetched before the interval")
	}
}

func TestFullCacheApplyPoll(t *testing.T) {
	t0 := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	now := t0.Add(5 * time.Minute)
	pr := func(id string, mutate func(*PullRequest)) PullRequest {
		p := PullRequest{ID: id, State: PullRequestOpen, UpdatedAt: t0, HeadSHA: "h1",
			Mergeable: MergeableMergeable, MergeStateStatus: "CLEAN",
			Checks: CheckRollup{State: RollupSuccess, Total: 2, Passed: 2}}
		if mutate != nil {
			mutate(&p)
		}
		return p
	}
	fp := func(p PullRequest) prFingerprint {
		return prFingerprint{ID: p.ID, UpdatedAt: p.UpdatedAt, State: p.State, HeadSHA: p.HeadSHA, Checks: p.Checks, HasChecks: true}
	}
	unchanged := pr("PR_x", nil)
	tests := []struct {
		name          string
		cached        PullRequest
		stale         bool
		seen          []prFingerprint
		wantStale     bool
		wantConfirmed bool
		wantKeys      int
	}{
		{name: "unchanged: confirmed", cached: unchanged, seen: []prFingerprint{fp(unchanged)}, wantConfirmed: true},
		{name: "updatedAt moved: stale", cached: unchanged,
			seen:      []prFingerprint{fp(pr("PR_x", func(p *PullRequest) { p.UpdatedAt = t0.Add(time.Minute) }))},
			wantStale: true, wantKeys: 1},
		{name: "check counts moved: stale", cached: unchanged,
			seen:      []prFingerprint{fp(pr("PR_x", func(p *PullRequest) { p.Checks.Total, p.Checks.Passed = 3, 3 }))},
			wantStale: true, wantKeys: 1},
		{name: "not in the poll (uncovered): untouched", cached: unchanged, seen: []prFingerprint{fp(pr("PR_other", nil))}},
		{name: "already stale: stays stale, not confirmed, not announced again", cached: unchanged, stale: true,
			seen: []prFingerprint{fp(unchanged)}, wantStale: true},
		{name: "mergeability still computing: not confirmed",
			cached: pr("PR_x", func(p *PullRequest) { p.Mergeable = MergeableUnknown }),
			seen:   []prFingerprint{fp(unchanged)}},
		{name: "merge state still computing: not confirmed",
			cached: pr("PR_x", func(p *PullRequest) { p.MergeStateStatus = "UNKNOWN" }),
			seen:   []prFingerprint{fp(unchanged)}},
		{name: "merged with unknown mergeability: confirmed",
			cached: pr("PR_x", func(p *PullRequest) { p.State, p.Mergeable, p.MergeStateStatus = PullRequestMerged, MergeableUnknown, "UNKNOWN" }),
			seen:   []prFingerprint{fp(pr("PR_x", func(p *PullRequest) { p.State = PullRequestMerged }))}, wantConfirmed: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var c fullCache
			k := fullKey{"o/r", 1}
			c.put(k, FullPullRequest{PullRequest: tt.cached, FetchedAt: t0})
			if tt.stale {
				c.markStale(k)
			}
			keys := c.applyPoll(tt.seen, now)
			e, _ := c.entry(k)
			if len(keys) != tt.wantKeys || e.stale != tt.wantStale || e.confirmed.Equal(now) != tt.wantConfirmed {
				t.Errorf("keys %v, stale %v, confirmed %v; want %d keys, stale %v, confirmed %v",
					keys, e.stale, e.confirmed, tt.wantKeys, tt.wantStale, tt.wantConfirmed)
			}
		})
	}

	// A fetch replaces the entry unconfirmed: until the next poll, the age rule applies.
	var c fullCache
	k := fullKey{"o/r", 1}
	c.put(k, FullPullRequest{PullRequest: unchanged, FetchedAt: t0})
	c.applyPoll([]prFingerprint{fp(unchanged)}, now)
	c.put(k, FullPullRequest{PullRequest: unchanged, FetchedAt: now})
	if e, _ := c.entry(k); !e.confirmed.IsZero() {
		t.Errorf("a new fetch kept the old confirmation %v", e.confirmed)
	}
}
