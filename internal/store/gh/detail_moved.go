package gh

import (
	"sync"
	"time"
)

// movedDetails records when the poll last saw a pull request's fingerprint move (or
// the store changed it), so PullRequest refetches a cached detail fetched before that
// instead of serving it until DetailTTL. That read backs the plugins' pr.checks fact,
// which a PullRequestChanged invalidates: without this it could refetch the copy the
// change made stale.
type movedDetails struct {
	mu sync.Mutex
	m  map[fullKey]time.Time
}

// mark records that k moved at at, and drops the marks older than ttl: a cached detail
// fetched before those is past DetailTTL anyway.
func (d *movedDetails) mark(k fullKey, at time.Time, ttl time.Duration) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.m == nil {
		d.m = map[fullKey]time.Time{}
	}
	for key, t := range d.m {
		if at.Sub(t) > ttl {
			delete(d.m, key)
		}
	}
	d.m[k] = at
}

// movedSince reports whether k moved after a detail fetched at fetched.
func (d *movedDetails) movedSince(k fullKey, fetched time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, ok := d.m[k]
	return ok && t.After(fetched)
}

// markMovedDetails is the poll's hook: every pull request whose fingerprint moved from
// what the store held (or that it did not hold) gets its cached PullRequest detail
// marked.
func (s *Store) markMovedDetails(fps []prFingerprint, known map[string]PullRequest) {
	now := s.opts.Now()
	for _, f := range fps {
		if f.Repo == "" || f.Number <= 0 {
			continue
		}
		if k, ok := known[f.ID]; !ok || fingerprintMoved(k, f) {
			s.moved.mark(fullKey{f.Repo, f.Number}, now, s.opts.DetailTTL)
		}
	}
}
