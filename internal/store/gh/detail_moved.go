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
	mu      sync.Mutex
	m       map[fullKey]time.Time
	written map[fullKey]time.Time
}

// mark records that k moved at at, and drops the marks older than ttl: a cached detail
// fetched before those is past DetailTTL anyway.
func (d *movedDetails) mark(k fullKey, at time.Time, ttl time.Duration) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.markLocked(k, at, ttl)
}

func (d *movedDetails) markLocked(k fullKey, at time.Time, ttl time.Duration) {
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

// markWrite records a local write on k at at, invalidating both PullRequest details and
// SQLite-hydrated FullPullRequest validation for confirmedMaxAge.
func (d *movedDetails) markWrite(k fullKey, at time.Time, ttl time.Duration) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.markLocked(k, at, ttl)
	if d.written == nil {
		d.written = map[fullKey]time.Time{}
	}
	for key, t := range d.written {
		if at.Sub(t) > confirmedMaxAge {
			delete(d.written, key)
		}
	}
	d.written[k] = at
}

// movedSince reports whether k moved after a detail fetched at fetched.
func (d *movedDetails) movedSince(k fullKey, fetched time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, ok := d.m[k]
	return ok && t.After(fetched)
}

// writtenSince reports whether a local write invalidated k at or after fetched.
func (d *movedDetails) writtenSince(k fullKey, fetched time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, ok := d.written[k]
	return ok && !t.Before(fetched)
}

// markMovedDetails is the poll's hook: every pull request whose fingerprint moved from
// what the store held (or that it did not hold) gets its cached PullRequest detail
// marked. Check-count-only ticks while CI stays PENDING patch the in-memory detail in
// place instead of marking it moved.
func (s *Store) markMovedDetails(fps []prFingerprint, known map[string]PullRequest) {
	now := s.opts.Now()
	snap := s.Snapshot()
	for _, f := range fps {
		if f.Repo == "" || f.Number <= 0 {
			continue
		}
		k := fullKey{f.Repo, f.Number}
		localSlug := snap.LocalRepo(f.Repo)
		if prev, ok := known[f.ID]; ok && pendingCheckCountsOnly(prev, f) {
			s.prDetails.patchChecks(k, f.Checks)
			if localSlug != f.Repo {
				s.prDetails.patchChecks(fullKey{localSlug, f.Number}, f.Checks)
			}
			continue
		} else if !ok || fingerprintMoved(prev, f) {
			s.moved.mark(k, now, s.opts.DetailTTL)
			if localSlug != f.Repo {
				s.moved.mark(fullKey{localSlug, f.Number}, now, s.opts.DetailTTL)
			}
		}
	}
}
