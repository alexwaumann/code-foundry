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
// Cache rules (docs/notes/gh-pr-detail.md): an entry is served until the caller asks
// for a refresh, it is older than the poll interval, or the poll saw the pull request's
// fingerprint move (updatedAt, state, head, check rollup). The poll marks the entry
// stale and publishes PullRequestDetailUpdated, so an open panel re-reads (and that
// read fetches). A fetch whose result differs from a fresh previous entry (a refresh,
// or one past its age) publishes it too, for the other clients showing it.
// Entries live in memory (fullCacheMax) and in gh_activity ("pr_detail:<slug>#<n>"),
// which serves as the fallback when a fetch fails, also after a restart. A row read
// back from SQLite starts stale: polls that ran while it was not in memory (evicted, or
// the daemon was down) could not mark it.

// fullCacheMax bounds the in-memory entries; the least recently fetched go first.
const fullCacheMax = 64

// revertMemoTTL is how long a revert's result answers repeated revert calls for the
// same pull request instead of opening another revert.
const revertMemoTTL = 2 * time.Minute

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
}

// revertMemo is a revert's outcome for revertMemoTTL: the pull request it opened or,
// when GitHub did not answer (err), that it may have opened one.
type revertMemo struct {
	res RevertResult
	err error
	at  time.Time
}

// fullCache is the in-memory detail cache. The zero value is ready to use.
type fullCache struct {
	mu      sync.Mutex
	m       map[fullKey]*fullEntry
	reverts map[fullKey]revertMemo
}

func (c *fullCache) get(k fullKey) (d FullPullRequest, stale, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok {
		return FullPullRequest{}, false, false
	}
	return e.d, e.stale, true
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

// adopt stores d (loaded from SQLite) as stale unless an entry exists, in one step, and
// returns the entry cached afterwards.
func (c *fullCache) adopt(k fullKey, d FullPullRequest) (FullPullRequest, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.m[k]; ok {
		return e.d, e.stale
	}
	c.putLocked(k, &fullEntry{d: d, stale: true})
	return d, true
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

// staleMoved marks stale every fresh entry whose pull request's fingerprint in fps
// moved, and returns their keys.
func (c *fullCache) staleMoved(fps []prFingerprint) []fullKey {
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
		if !ok || e.stale || !fingerprintMoved(e.d.PullRequest, f) {
			continue
		}
		e.stale = true
		out = append(out, k)
	}
	return out
}

// recentRevert returns the outcome of a revert of k within revertMemoTTL of now.
func (c *fullCache) recentRevert(k fullKey, now time.Time) (revertMemo, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	m, ok := c.reverts[k]
	if !ok || now.Sub(m.at) > revertMemoTTL {
		return revertMemo{}, false
	}
	return m, true
}

func (c *fullCache) rememberRevert(k fullKey, m revertMemo) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.reverts == nil {
		c.reverts = map[fullKey]revertMemo{}
	}
	for key, old := range c.reverts {
		if m.at.Sub(old.at) > revertMemoTTL {
			delete(c.reverts, key)
		}
	}
	c.reverts[k] = m
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
	cached, stale, ok := s.cachedFull(ctx, k)
	if ok && !refresh && !stale && s.opts.Now().Sub(cached.FetchedAt) < s.config().PollInterval {
		return cached, nil
	}
	d, err := s.fetchFullJob(ctx, k)
	if err != nil {
		if ok && ctx.Err() == nil {
			cached.LastError = err.Error()
			return cached, nil
		}
		return FullPullRequest{}, err
	}
	return d, nil
}

// cachedFull returns the cached detail of k from memory or, failing that, SQLite.
func (s *Store) cachedFull(ctx context.Context, k fullKey) (d FullPullRequest, stale, ok bool) {
	if d, stale, ok = s.full.get(k); ok {
		return d, stale, true
	}
	row, found, err := loadActivityRow[FullPullRequest](ctx, s.cache, activityFull+k.String())
	if err != nil {
		s.log.Warn("gh cache read failed", "err", err)
	}
	if !found {
		return FullPullRequest{}, false, false
	}
	d, stale = s.full.adopt(k, row)
	return d, stale, true
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
// moved go stale, and clients hear about it.
func (s *Store) staleFullDetails(fps []prFingerprint) {
	for _, k := range s.full.staleMoved(fps) {
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
