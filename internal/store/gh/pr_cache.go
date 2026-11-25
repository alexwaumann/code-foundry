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
	pr              PullRequest
	polled          PullRequest
	polledAt        time.Time
	polledHasChecks bool
	seq             uint64
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

// polledSummary returns the latest live-poll summary for k, when a live poll has seen k.
func (c *prSummaryCache) polledSummary(k fullKey) (pr PullRequest, polledAt time.Time, hasChecks bool, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, found := c.m[k]
	if !found || e.polledAt.IsZero() {
		return PullRequest{}, time.Time{}, false, false
	}
	e.seq = c.nextSeqLocked()
	return e.polled, e.polledAt, e.polledHasChecks, true
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

func (c *prSummaryCache) putPollLocked(k fullKey, p PullRequest, polledAt time.Time, hasChecks bool) {
	if k.slug == "" || k.number <= 0 {
		return
	}
	c.ensureLocked()
	seq := c.nextSeqLocked()
	e, ok := c.m[k]
	if !ok {
		c.m[k] = &prSummaryEntry{
			pr:              p,
			polled:          p,
			polledAt:        polledAt,
			polledHasChecks: hasChecks,
			seq:             seq,
		}
		c.evictLocked(k)
		return
	}
	if newerCopy(p, e.pr) {
		e.pr = p
	}
	// Within the same poll timestamp, prefer a copy that carries checks and is non-partial.
	switch {
	case polledAt.After(e.polledAt):
		e.polled, e.polledAt, e.polledHasChecks = p, polledAt, hasChecks
	case polledAt.Equal(e.polledAt):
		if (hasChecks && !e.polledHasChecks) || (hasChecks == e.polledHasChecks && newerCopy(p, e.polled)) {
			e.polled, e.polledHasChecks = p, hasChecks
		}
	}
	e.seq = seq
}

// indexPR records p under both its normalized repo slug and, if renamed, its local slug.
func (c *prSummaryCache) indexPRLocked(snap *Snapshot, p PullRequest, polledAt time.Time, hasChecks bool) {
	if p.Number <= 0 {
		return
	}
	repoSlug, err := NormalizeSlug(p.Repo)
	if err != nil {
		return
	}
	record := func(k fullKey) {
		if polledAt.IsZero() {
			c.putLocked(k, p)
		} else {
			c.putPollLocked(k, p, polledAt, hasChecks)
		}
	}
	record(fullKey{repoSlug, p.Number})
	if snap != nil {
		if local := snap.LocalRepo(repoSlug); local != repoSlug {
			if lk, err := NormalizeSlug(local); err == nil {
				record(fullKey{lk, p.Number})
			}
		}
	}
}

// putDashboard indexes all pull requests in d. Pass non-zero polledAt only for live polls.
func (c *prSummaryCache) putDashboard(snap *Snapshot, d Dashboard, polledAt time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, list := range [][]PullRequest{d.Authored, d.ReviewRequested, d.Reviewed} {
		for _, p := range list {
			c.indexPRLocked(snap, p, polledAt, true)
		}
	}
	for _, p := range d.RecentlyMerged {
		c.indexPRLocked(snap, p, polledAt, false)
	}
}

// putProjects indexes all pull requests in p. Pass non-zero polledAt only for live polls.
func (c *prSummaryCache) putProjects(snap *Snapshot, p ProjectPullRequests, polledAt time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, pr := range p.Open.PullRequests {
		c.indexPRLocked(snap, pr, polledAt, true)
	}
	for _, pr := range p.Merged.PullRequests {
		c.indexPRLocked(snap, pr, polledAt, false)
	}
}

// putBranch indexes all pull requests in a watched branch list. Pass non-zero polledAt
// only for live polls.
func (c *prSummaryCache) putBranch(snap *Snapshot, slug string, prs []PullRequest, polledAt time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, pr := range prs {
		if pr.Repo == "" {
			pr.Repo = slug
		}
		c.indexPRLocked(snap, pr, polledAt, true)
	}
}

// prMatchesPollSummary reports whether a SQLite-loaded FullPullRequest's summary agrees
// with the latest live poll's summary on every tracked field.
func prMatchesPollSummary(cached, polled PullRequest, polledHasChecks bool) bool {
	if polled.Partial || cached.ID == "" || cached.ID != polled.ID {
		return false
	}
	if !cached.UpdatedAt.Equal(polled.UpdatedAt) ||
		cached.HeadSHA != polled.HeadSHA ||
		cached.State != polled.State ||
		cached.Draft != polled.Draft {
		return false
	}
	if polledHasChecks {
		if cached.Checks != polled.Checks {
			return false
		}
	} else if cached.State == PullRequestOpen {
		return false
	}
	if polled.State == PullRequestOpen {
		if cached.ReviewDecision != polled.ReviewDecision ||
			cached.Comments != polled.Comments ||
			cached.Reviews != polled.Reviews ||
			cached.Mergeable != polled.Mergeable ||
			cached.MergeStateStatus != polled.MergeStateStatus {
			return false
		}
	}
	return true
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

// patchChecks updates the cached summary check counts in place while CI runs.
func (c *detailCache) patchChecks(k fullKey, checks CheckRollup) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.m[k]; ok {
		e.d.PullRequest.Checks = checks
	}
}

func clonePullRequestDetail(d PullRequestDetail) PullRequestDetail {
	d.Checks = slices.Clone(d.Checks)
	d.PullRequest.LatestReviews = slices.Clone(d.PullRequest.LatestReviews)
	d.PullRequest.ReviewRequests = slices.Clone(d.PullRequest.ReviewRequests)
	return d
}
