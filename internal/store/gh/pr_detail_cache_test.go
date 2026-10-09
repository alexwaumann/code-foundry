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
	if d, stale := c.adopt(k, row); d.Body != "from sqlite" || !stale {
		t.Errorf("adopt into empty = %q stale %v, want the row, stale", d.Body, stale)
	}
	c.put(k, fresh)
	if d, stale := c.adopt(k, row); d.Body != "fetched" || stale {
		t.Errorf("adopt over a fetched entry = %q stale %v, want it kept", d.Body, stale)
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
