package gh

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// The pull request detail panel's data (GetPullRequestDetail). One GraphQL request
// (pull_request_full.graphql) per fetch, plus Checks pages only beyond 100 checks.
//
// Cache rules (docs/notes/gh-pr-detail.md, docs/notes/gh-detail-cache-confirm.md): an
// entry is served until the caller asks for a refresh, the poll saw the pull request's
// fingerprint move (updatedAt, state, head, check rollup), or it is too old. The poll
// marks a moved entry stale and publishes PullRequestDetailUpdated, so an open panel
// re-reads (and that read fetches). Too old is past the poll interval (closedDetailTTL
// for merged and closed pull requests), unless a recent poll confirmed the entry: it
// saw the fingerprint unchanged (fullEntry.serves). Only pull requests the poll covers
// (dashboards, watched branches) are ever confirmed. A fetch whose result differs from a fresh previous entry (a refresh,
// or one past its age) publishes it too, for the other clients showing it.
// Entries live in memory (fullCacheMax) and in gh_activity ("pr_detail:<slug>#<n>"),
// which serves as the fallback when a fetch fails, also after a restart. A row read
// back from SQLite starts stale: polls that ran while it was not in memory (evicted, or
// the daemon was down) could not mark it.

// fullCacheMax bounds the in-memory entries; the least recently fetched go first.
const fullCacheMax = 64

// closedDetailTTL replaces the poll interval as the age limit of a merged or closed
// pull request's detail (or the poll interval, when that is longer): little changes on
// it after it closes, and a panel left open on one re-read it every interval.
const closedDetailTTL = 10 * time.Minute

// confirmedMaxAge bounds how long confirmations keep an entry: some changes do not move
// the fingerprint (the base branch moving changes mergeStateStatus, a thread resolved),
// so even a confirmed entry is refetched once it is this old.
const confirmedMaxAge = 10 * time.Minute

// writeMemoTTL is how long a revert's or a merge's outcome (or a review's or comment's,
// for the same text) answers repeated calls for the same pull request instead of
// sending the mutation again.
const writeMemoTTL = 2 * time.Minute

type fullKey struct {
	slug   string
	number int
}

func (k fullKey) String() string { return fmt.Sprintf("%s#%d", k.slug, k.number) }

func fullKeyOf(slug string, number int) (fullKey, error) {
	key, err := NormalizeSlug(slug)
	if err != nil {
		return fullKey{}, err
	}
	if number <= 0 {
		return fullKey{}, fmt.Errorf("%w: pull request number %d", ErrInvalidArgument, number)
	}
	return fullKey{key, number}, nil
}

type fullEntry struct {
	d     FullPullRequest
	stale bool // the poll saw the pull request change since d was fetched
	// confirmed is when a poll last saw the pull request's fingerprint unchanged since d
	// was fetched; zero until one does.
	confirmed time.Time
}

// serves reports whether e may be served at now without a fetch: it is not stale, and
// it is younger than its age limit (the poll interval; closedDetailTTL once merged or
// closed) or a poll confirmed it within confirmWindow, up to confirmedMaxAge.
func (e fullEntry) serves(now time.Time, pollInterval time.Duration) bool {
	if e.stale {
		return false
	}
	age := now.Sub(e.d.FetchedAt)
	limit := pollInterval
	if st := e.d.PullRequest.State; st == PullRequestMerged || st == PullRequestClosed {
		limit = max(limit, closedDetailTTL)
	}
	if age < limit {
		return true
	}
	return !e.confirmed.IsZero() && now.Sub(e.confirmed) < confirmWindow(pollInterval) && age < confirmedMaxAge
}

// confirmWindow is how long a poll's confirmation holds: one interval plus half of one,
// because the next poll is scheduled an interval after the previous one ended and
// confirms only once its fingerprint request returns (seconds later).
func confirmWindow(pollInterval time.Duration) time.Duration {
	return pollInterval + pollInterval/2
}

// confirmable reports whether a poll that saw d's fingerprint unchanged vouches for
// all of d. An open pull request whose mergeability GitHub is still computing is not:
// the result lands without moving updatedAt, so it waits for the age rule.
func confirmable(d FullPullRequest) bool {
	p := d.PullRequest
	return p.State != PullRequestOpen || (p.Mergeable != MergeableUnknown && p.MergeStateStatus != "UNKNOWN")
}

// writeMemo is a mutation's outcome for writeMemoTTL: its result (the pull request a
// revert opened, a merge) or, when GitHub did not answer (err), that it may have run.
type writeMemo[T any] struct {
	res T
	err error
	at  time.Time
}

// writeMemos holds the recent outcomes of one kind of mutation, keyed by K (the pull
// request, or the pull request and what was written). The zero value is ready to use.
type writeMemos[K comparable, T any] struct {
	mu sync.Mutex
	m  map[K]writeMemo[T]
}

// recent returns the outcome for k within writeMemoTTL of now.
func (w *writeMemos[K, T]) recent(k K, now time.Time) (writeMemo[T], bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	m, ok := w.m[k]
	if !ok || now.Sub(m.at) > writeMemoTTL {
		return writeMemo[T]{}, false
	}
	return m, true
}

// remember records k's outcome and drops the expired ones.
func (w *writeMemos[K, T]) remember(k K, m writeMemo[T]) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.m == nil {
		w.m = map[K]writeMemo[T]{}
	}
	for key, old := range w.m {
		if m.at.Sub(old.at) > writeMemoTTL {
			delete(w.m, key)
		}
	}
	w.m[k] = m
}

// fullCache is the in-memory detail cache. The zero value is ready to use.
type fullCache struct {
	mu sync.Mutex
	m  map[fullKey]*fullEntry
	// reverts and merges answer repeats of a recent revert or merge (pr_actions.go,
	// pr_merge.go); mergeLocks runs one merge of a pull request at a time. reviews and
	// comments answer an identical review or comment sent again soon (pr_review.go).
	reverts    writeMemos[fullKey, RevertResult]
	merges     writeMemos[fullKey, mergeMemo]
	mergeLocks keyLocks
	reviews    writeMemos[writeKey, SubmittedReview]
	comments   writeMemos[writeKey, PostedComment]
}

func (c *fullCache) get(k fullKey) (d FullPullRequest, stale, ok bool) {
	e, ok := c.entry(k)
	return e.d, e.stale, ok
}

// entry returns a copy of k's entry.
func (c *fullCache) entry(k fullKey) (fullEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok {
		return fullEntry{}, false
	}
	return *e, true
}

// put stores d as fresh and returns the entry it replaced.
func (c *fullCache) put(k fullKey, d FullPullRequest) (prev fullEntry, had bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.putLocked(k, &fullEntry{d: d})
}

// putLocked stores e, evicting the least recently fetched beyond fullCacheMax. c.mu is
// held.
func (c *fullCache) putLocked(k fullKey, e *fullEntry) (prev fullEntry, had bool) {
	if c.m == nil {
		c.m = map[fullKey]*fullEntry{}
	}
	if old, ok := c.m[k]; ok {
		prev, had = *old, true
	}
	c.m[k] = e
	for len(c.m) > fullCacheMax {
		var oldest fullKey
		first := true
		for key, e := range c.m {
			if key != k && (first || e.d.FetchedAt.Before(c.m[oldest].d.FetchedAt)) {
				oldest, first = key, false
			}
		}
		delete(c.m, oldest)
	}
	return prev, had
}

// adopt stores d (loaded from SQLite) as stale and unconfirmed unless an entry exists,
// in one step, and returns the entry cached afterwards.
func (c *fullCache) adopt(k fullKey, d FullPullRequest) fullEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.m[k]; ok {
		return *e
	}
	e := &fullEntry{d: d, stale: true}
	c.putLocked(k, e)
	return *e
}

// markStale marks k stale; it reports whether there was a fresh entry.
func (c *fullCache) markStale(k fullKey) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok || e.stale {
		return false
	}
	e.stale = true
	return true
}

// applyPoll records what a poll saw: every fresh entry whose pull request's fingerprint
// in fps moved goes stale (their keys are returned), and every other fresh one in fps
// is confirmed at now when its detail allows (confirmable).
func (c *fullCache) applyPoll(fps []prFingerprint, now time.Time) []fullKey {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) == 0 {
		return nil
	}
	byID := make(map[string]prFingerprint, len(fps))
	for _, f := range fps {
		byID[f.ID] = f
	}
	var out []fullKey
	for k, e := range c.m {
		f, ok := byID[e.d.PullRequest.ID]
		switch {
		case !ok || e.stale:
		case fingerprintMoved(e.d.PullRequest, f):
			e.stale = true
			out = append(out, k)
		case confirmable(e.d):
			e.confirmed = now
		}
	}
	return out
}

// fingerprintMoved reports whether the poll's fingerprint of a pull request differs
// from what a detail fetched earlier recorded.
func fingerprintMoved(p PullRequest, f prFingerprint) bool {
	switch {
	case !p.UpdatedAt.Equal(f.UpdatedAt), p.State != f.State, p.HeadSHA != f.HeadSHA:
		return true
	case f.HasChecks && p.Checks != f.Checks:
		return true
	}
	return false
}

// sameFull compares everything clients see except FetchedAt.
func sameFull(a, b FullPullRequest) bool {
	a.FetchedAt, b.FetchedAt = time.Time{}, time.Time{}
	return sameJSON(a, b)
}

// FullPullRequest implements Service.
func (s *Store) FullPullRequest(ctx context.Context, slug string, number int, refresh bool) (FullPullRequest, error) {
	k, err := fullKeyOf(slug, number)
	if err != nil {
		return FullPullRequest{}, err
	}
	e, ok := s.cachedFull(ctx, k)
	if ok && !refresh && e.serves(s.opts.Now(), s.config().PollInterval) {
		return e.d, nil
	}
	d, err := s.fetchFullJob(ctx, k)
	if err != nil {
		if ok && ctx.Err() == nil {
			cached := e.d
			cached.LastError = err.Error()
			return cached, nil
		}
		return FullPullRequest{}, err
	}
	return d, nil
}

// cachedFull returns the cached entry of k from memory or, failing that, SQLite.
func (s *Store) cachedFull(ctx context.Context, k fullKey) (fullEntry, bool) {
	if e, ok := s.full.entry(k); ok {
		return e, true
	}
	row, found, err := loadActivityRow[FullPullRequest](ctx, s.cache, activityFull+k.String())
	if err != nil {
		s.log.Warn("gh cache read failed", "err", err)
	}
	if !found {
		return fullEntry{}, false
	}
	return s.full.adopt(k, row), true
}

// fetchFullJob fetches k on the worker and returns GitHub's error, if any. Jobs with
// the same id coalesce only while queued, so a job that finds an entry fetched after
// it was submitted (by one that was already running) returns that instead of fetching
// again.
func (s *Store) fetchFullJob(ctx context.Context, k fullKey) (FullPullRequest, error) {
	submitted := s.opts.Now()
	return submitFunc(ctx, s, "full|"+k.String(), func(ctx context.Context) (FullPullRequest, error) {
		if d, stale, ok := s.full.get(k); ok && !stale && d.FetchedAt.After(submitted) {
			return d, nil
		}
		return s.fetchFull(ctx, k)
	})
}

// fetchFull runs on the worker: the detail request, more check pages when there are
// over 100 checks, then the cache and, when it changed, PullRequestDetailUpdated. A
// failed checks page keeps the checks fetched so far: ChecksTruncated and LastError say
// so.
func (s *Store) fetchFull(ctx context.Context, k fullKey) (FullPullRequest, error) {
	owner, name := splitSlug(k.slug)
	data, err := s.call(ctx, queryPullRequestFull, map[string]any{"owner": owner, "name": name, "number": k.number})
	if err != nil && !isPartial(err) {
		return FullPullRequest{}, err
	}
	partialErr := err
	d, page, err := decodeFullPullRequest(data)
	switch {
	case err != nil && partialErr != nil:
		// A missing pull request is a NOT_FOUND part next to a null pullRequest: report
		// GitHub's message, not the decoder's.
		var pe *PartialError
		if errors.As(partialErr, &pe) {
			return FullPullRequest{}, pe.Unwrap()
		}
		return FullPullRequest{}, partialErr
	case err != nil:
		return FullPullRequest{}, err
	case partialErr != nil:
		s.log.Warn("gh pull request detail has partial errors", "pr", k.String(), "err", partialErr)
	}
	runs, next := page.Runs, page.Next
	for p := 1; next.HasNextPage && next.EndCursor != "" && p < s.opts.MaxPages; p++ {
		data, err := s.call(ctx, queryChecks, map[string]any{"owner": owner, "name": name, "ref": d.PullRequest.HeadSHA, "after": next.EndCursor})
		var cp checksPage
		if err == nil {
			cp, _, err = decodeChecks(data)
		}
		if err != nil {
			s.log.Warn("gh pull request detail checks page failed", "pr", k.String(), "err", err)
			d.LastError = fmt.Sprintf("checks after the first %d: %v", len(runs), err)
			break
		}
		runs, next = append(runs, cp.Runs...), cp.Next
	}
	sortRuns(runs)
	d.Checks = runs
	d.ChecksTruncated = next.HasNextPage
	d.FetchedAt = s.opts.Now()
	prev, had := s.full.put(k, d)
	if err := s.cache.saveActivity(ctx, activityFull+k.String(), d.FetchedAt, d); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	// A stale entry was announced when it went stale; every read since fetches, so this
	// result needs no second announcement.
	if had && !prev.stale && !sameFull(prev.d, d) {
		publish(s, PullRequestDetailUpdated{Slug: k.slug, Number: k.number})
	}
	return d, nil
}

// staleFullDetails is the poll's hook: cached details whose pull request's fingerprint
// moved go stale, and clients hear about it; the others it saw are confirmed.
func (s *Store) staleFullDetails(fps []prFingerprint) {
	for _, k := range s.full.applyPoll(fps, s.opts.Now()) {
		publish(s, PullRequestDetailUpdated{Slug: k.slug, Number: k.number})
	}
}

// invalidateFull marks a cached detail stale after a change the store made and tells
// clients to re-read.
func (s *Store) invalidateFull(k fullKey) {
	s.full.markStale(k)
	publish(s, PullRequestDetailUpdated{Slug: k.slug, Number: k.number})
}

// submitFunc queues run as an on-demand job (coalescing with a queued job of the same
// id) and returns its result.
func submitFunc[T any](ctx context.Context, s *Store, id string, run func(context.Context) (T, error)) (T, error) {
	var zero T
	res := s.submit(ctx, &job{kind: jobFunc, id: id, run: func(ctx context.Context) (any, error) { return run(ctx) }})
	if res.err != nil {
		return zero, res.err
	}
	v, ok := res.value.(T)
	if !ok {
		return zero, fmt.Errorf("gh: job %s returned %T", id, res.value)
	}
	return v, nil
}
