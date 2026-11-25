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
	seq     map[fullKey]uint64
	written map[fullKey]time.Time
}

// markSeq records that k moved at at (observed by request sequence fpSeq) and drops marks
// older than ttl: a cached detail fetched before those is past DetailTTL anyway.
func (d *movedDetails) markSeq(k fullKey, at time.Time, fpSeq uint64, ttl time.Duration) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.markLocked(k, at, fpSeq, ttl)
}

func (d *movedDetails) markLocked(k fullKey, at time.Time, fpSeq uint64, ttl time.Duration) {
	if d.m == nil {
		d.m = map[fullKey]time.Time{}
	}
	for key, t := range d.m {
		if at.Sub(t) > ttl {
			delete(d.m, key)
			delete(d.seq, key)
		}
	}
	d.m[k] = at
	if fpSeq > 0 {
		if d.seq == nil {
			d.seq = map[fullKey]uint64{}
		}
		if fpSeq > d.seq[k] {
			d.seq[k] = fpSeq
		}
	}
}

// markWrite records a local write on k at at, invalidating both PullRequest details and
// SQLite-hydrated FullPullRequest validation for confirmedMaxAge.
func (d *movedDetails) markWrite(k fullKey, at time.Time, ttl time.Duration) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.markLocked(k, at, 0, ttl)
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
	return d.movedSinceSeq(k, fetched, 0)
}

// movedSinceSeq reports whether k moved after a detail fetched at fetched with request
// sequence fetchSeq. A late response from a fetch sent before the moving poll (fetchSeq > 0
// && markSeq > fetchSeq) counts as moved even when its response arrived after the mark.
func (d *movedDetails) movedSinceSeq(k fullKey, fetched time.Time, fetchSeq uint64) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, ok := d.m[k]
	if !ok {
		return false
	}
	if t.After(fetched) {
		return true
	}
	return fetchSeq > 0 && d.seq[k] > fetchSeq
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
// marked at apply time so PullRequest() refetches fresh check-run rows (backing plugin
// pr.checks facts). Marks are skipped only when an in-memory detail was fetched after
// fpSeq and already reflects or supersedes the poll fingerprint.
func (s *Store) markMovedDetails(fps []prFingerprint, known map[string]PullRequest, fpSeq uint64) {
	now := s.opts.Now()
	snap := s.Snapshot()
	for _, f := range fps {
		if f.Repo == "" || f.Number <= 0 {
			continue
		}
		if prev, ok := known[f.ID]; !ok || fingerprintMoved(prev, f) {
			k := fullKey{f.Repo, f.Number}
			if !s.prDetails.newerThan(k, fpSeq, f) {
				s.moved.markSeq(k, now, fpSeq, s.opts.DetailTTL)
			}
			if localSlug := snap.LocalRepo(f.Repo); localSlug != f.Repo {
				lk := fullKey{localSlug, f.Number}
				if !s.prDetails.newerThan(lk, fpSeq, f) {
					s.moved.markSeq(lk, now, fpSeq, s.opts.DetailTTL)
				}
			}
		}
	}
}
