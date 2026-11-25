package gh

import (
	"slices"
	"sync"
	"time"
)

// In-memory pull request summary and detail caches.
//
// prSummaryCache is a canonical slug#number -> PullRequest index updated whenever
// Snapshot.Dashboard, Snapshot.Projects, s.branches, PullRequest (GetPullRequest), or
// FullPullRequest updates a pull request. It also remembers the latest summary observed
// by a live poll (polledAt > 0), which lets cachedFull validate a FullPullRequest
// loaded from SQLite without a redundant GraphQL fetch when a live poll confirmed the
// pull request did not move.
//
// detailCache keeps PullRequestDetail values in memory (bounded by detailCacheMax) so
// repeated PullRequest calls avoid SQLite reads and unmarshaling on cache hits.

const (
	summaryCacheMax = 1024
	detailCacheMax  = 64
)

type prSummaryEntry struct {
	pr       PullRequest
	polledFP prFingerprint
	polledAt time.Time
	seq      uint64
}

// prSummaryCache is the canonical in-memory pull request summary index. The zero value
// is ready to use.
type prSummaryCache struct {
	mu  sync.Mutex
	m   map[fullKey]*prSummaryEntry
	seq uint64
}

func (c *prSummaryCache) nextSeqLocked() uint64 {
	c.seq++
	return c.seq
}

func (c *prSummaryCache) ensureLocked() {
	if c.m == nil {
		c.m = map[fullKey]*prSummaryEntry{}
	}
}

func (c *prSummaryCache) evictLocked(keep fullKey) {
	for len(c.m) > summaryCacheMax {
		var oldest fullKey
		var minSeq uint64
		first := true
		for k, e := range c.m {
			if k != keep && (first || e.seq < minSeq) {
				oldest, minSeq, first = k, e.seq, false
			}
		}
		if first {
			return
		}
		delete(c.m, oldest)
	}
}

// get returns the latest known PullRequest summary for k.
func (c *prSummaryCache) get(k fullKey) (PullRequest, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok {
		return PullRequest{}, false
	}
	e.seq = c.nextSeqLocked()
	return e.pr, true
}

// polledFingerprint returns the latest live-poll fingerprint for k, when a live poll has seen k.
func (c *prSummaryCache) polledFingerprint(k fullKey) (fp prFingerprint, polledAt time.Time, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, found := c.m[k]
	if !found || e.polledAt.IsZero() {
		return prFingerprint{}, time.Time{}, false
	}
	e.seq = c.nextSeqLocked()
	return e.polledFP, e.polledAt, true
}

// put stores p as a known summary for k without marking it live-polled.
func (c *prSummaryCache) put(k fullKey, p PullRequest) {
	if k.slug == "" || k.number <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.putLocked(k, p)
}

func (c *prSummaryCache) putLocked(k fullKey, p PullRequest) {
	c.ensureLocked()
	seq := c.nextSeqLocked()
	if e, ok := c.m[k]; ok {
		if newerCopy(p, e.pr) {
			e.pr = p
		}
		e.seq = seq
		return
	}
	c.m[k] = &prSummaryEntry{pr: p, seq: seq}
	c.evictLocked(k)
}

func (c *prSummaryCache) putFingerprintLocked(k fullKey, fp prFingerprint, polledAt time.Time) {
	if k.slug == "" || k.number <= 0 || fp.ID == "" || polledAt.IsZero() {
		return
	}
	c.ensureLocked()
	seq := c.nextSeqLocked()
	e, ok := c.m[k]
	if !ok {
		c.m[k] = &prSummaryEntry{
			polledFP: fp,
			polledAt: polledAt,
			seq:      seq,
		}
		c.evictLocked(k)
		return
	}
	// Within the same poll timestamp, prefer a fingerprint that carries checks.
	switch {
	case polledAt.After(e.polledAt):
		e.polledFP, e.polledAt = fp, polledAt
	case polledAt.Equal(e.polledAt):
		if fp.HasChecks && !e.polledFP.HasChecks {
			e.polledFP = fp
		}
	}
	e.seq = seq
}

// putFingerprints records live fingerprints observed directly from GitHub on a poll
// (never carried-over copies from failed detail fetches), under both canonical and local
// repository slugs.
func (c *prSummaryCache) putFingerprints(snap *Snapshot, fps []prFingerprint, polledAt time.Time) {
	if len(fps) == 0 || polledAt.IsZero() {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, f := range fps {
		if f.Number <= 0 || f.ID == "" {
			continue
		}
		repoSlug, err := NormalizeSlug(f.Repo)
		if err != nil {
			continue
		}
		c.putFingerprintLocked(fullKey{repoSlug, f.Number}, f, polledAt)
		if snap != nil {
			if local := snap.LocalRepo(repoSlug); local != repoSlug {
				if lk, err := NormalizeSlug(local); err == nil {
					c.putFingerprintLocked(fullKey{lk, f.Number}, f, polledAt)
				}
			}
		}
	}
}

// indexPRLocked records p under both its normalized repo slug and, if renamed, its local slug.
func (c *prSummaryCache) indexPRLocked(snap *Snapshot, p PullRequest) {
	if p.Number <= 0 {
		return
	}
	repoSlug, err := NormalizeSlug(p.Repo)
	if err != nil {
		return
	}
	c.putLocked(fullKey{repoSlug, p.Number}, p)
	if snap != nil {
		if local := snap.LocalRepo(repoSlug); local != repoSlug {
			if lk, err := NormalizeSlug(local); err == nil {
				c.putLocked(fullKey{lk, p.Number}, p)
			}
		}
	}
}

// putDashboard indexes all pull requests in d.
func (c *prSummaryCache) putDashboard(snap *Snapshot, d Dashboard) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, list := range [][]PullRequest{d.Authored, d.ReviewRequested, d.Reviewed, d.RecentlyMerged} {
		for _, p := range list {
			c.indexPRLocked(snap, p)
		}
	}
}

// putProjects indexes all pull requests in p.
func (c *prSummaryCache) putProjects(snap *Snapshot, p ProjectPullRequests) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, list := range [][]PullRequest{p.Open.PullRequests, p.Merged.PullRequests} {
		for _, pr := range list {
			c.indexPRLocked(snap, pr)
		}
	}
}

// putBranch indexes all pull requests in a watched branch list.
func (c *prSummaryCache) putBranch(snap *Snapshot, slug string, prs []PullRequest) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, pr := range prs {
		if pr.Repo == "" {
			pr.Repo = slug
		}
		c.indexPRLocked(snap, pr)
	}
}

// prMatchesFingerprint reports whether a SQLite-loaded FullPullRequest's summary agrees
// with the latest live poll's fingerprint (ID, UpdatedAt, State, HeadSHA, and Checks for
// open PRs) — the same invariant applyPoll uses to confirm an in-memory entry.
func prMatchesFingerprint(cached PullRequest, fp prFingerprint) bool {
	if cached.ID == "" || cached.ID != fp.ID {
		return false
	}
	if cached.State == PullRequestOpen && !fp.HasChecks {
		return false
	}
	return !fingerprintMoved(cached, fp)
}

type detailEntry struct {
	d   PullRequestDetail
	seq uint64
}

// detailCache is the bounded in-memory PullRequestDetail cache for Store.PullRequest.
// The zero value is ready to use.
type detailCache struct {
	mu  sync.Mutex
	m   map[fullKey]*detailEntry
	seq uint64
}

func (c *detailCache) get(k fullKey) (PullRequestDetail, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok {
		return PullRequestDetail{}, false
	}
	c.seq++
	e.seq = c.seq
	return clonePullRequestDetail(e.d), true
}

func (c *detailCache) put(k fullKey, d PullRequestDetail) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[fullKey]*detailEntry{}
	}
	c.seq++
	c.m[k] = &detailEntry{d: clonePullRequestDetail(d), seq: c.seq}
	for len(c.m) > detailCacheMax {
		var oldest fullKey
		var minSeq uint64
		first := true
		for key, e := range c.m {
			if key != k && (first || e.seq < minSeq) {
				oldest, minSeq, first = key, e.seq, false
			}
		}
		if first {
			return
		}
		delete(c.m, oldest)
	}
}

func clonePullRequestDetail(d PullRequestDetail) PullRequestDetail {
	d.Checks = slices.Clone(d.Checks)
	d.PullRequest.LatestReviews = slices.Clone(d.PullRequest.LatestReviews)
	d.PullRequest.ReviewRequests = slices.Clone(d.PullRequest.ReviewRequests)
	return d
}
