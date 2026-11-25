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
// Cache rules (docs/notes/gh-pr-detail.md, docs/notes/gh-detail-cache-confirm.md,
// docs/notes/pr-detail-stale-first.md): an entry is current until the poll saw the pull
// request's fingerprint move (updatedAt, state, head, check rollup) or it is too old.
// The poll marks a moved entry stale and publishes PullRequestDetailUpdated, so an open
// panel re-reads. Too old is past the poll interval (closedDetailTTL for merged and
// closed pull requests), unless a recent poll confirmed the entry: it saw the
// fingerprint unchanged (fullEntry.serves). Only pull requests the poll covers
// (dashboards, watched branches) are ever confirmed.
//
// A read never waits for GitHub while any copy exists (FullPullRequest): a copy that is
// not current comes back at once marked Refreshing, one fetch is queued behind the jobs
// someone waits for, and PullRequestDetailUpdated tells clients when it lands, changed
// or not, so they re-read. What waits: a read with nothing cached, a refresh, the read
// right after this store's own write, and a decision (currentFull).
//
// Entries live in memory (fullCacheMax) and in gh_activity ("pr_detail:<slug>#<n>"),
// which serves as the copy to show until a fetch lands, also after a restart. A row
// read back from SQLite starts stale: polls that ran while it was not in memory
// (evicted, or the daemon was down) could not mark it.

// fullCacheMax bounds the in-memory entries; the least recently fetched go first.
const fullCacheMax = 64

// closedDetailTTL replaces the poll interval as the age limit of a merged or closed
// pull request's detail (or the poll interval, when that is longer): little changes on
// it after it closes, and a panel left open on one re-read it every interval.
const closedDetailTTL = 10 * time.Minute

// fullRetryAfter is how long after a failed fetch reads serve the copy without trying
// again: the failure's own event brings a re-read at once, and that must not fetch.
const fullRetryAfter = 30 * time.Second

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
	stale bool // the poll saw a non-check or settled change since d was fetched
	// checksStale: only pending check counts moved on the same head SHA. The summary
	// Checks counts are patched immediately, and a background refresh fetches only
	// checks.graphql instead of the full pull_request_full document so check-run rows
	// stay accurate without re-reading comments, commits, reviews, and threads.
	checksStale bool
	// confirmed is when a poll last saw the pull request's fingerprint unchanged since d
	// was fetched; zero until one does.
	confirmed time.Time
	// written: this store's own write changed the pull request, so d is known wrong, not
	// just old. Reads wait for the fetch (read your writes); a failed fetch clears it.
	written bool
	// failure is why the last fetch since d failed, at failedAt; nil if none did.
	failure  error
	failedAt time.Time
}

// serves reports whether e may be served at now as current: it is not stale, and it is
// younger than its age limit (the configured poll interval; closedDetailTTL once merged
// or closed) or a poll confirmed it within confirmWindow of the poll's real cadence
// (pollCadence), up to confirmedMaxAge.
func (e fullEntry) serves(now time.Time, pollInterval, cadence time.Duration) bool {
	if e.stale || e.checksStale {
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
	return !e.confirmed.IsZero() && now.Sub(e.confirmed) < confirmWindow(cadence) && age < confirmedMaxAge
}

// confirmWindow is how long a poll's confirmation holds at a poll cadence: one interval
// plus half of one, because the next poll is scheduled an interval after the previous
// one ended and confirms only once its fingerprint request returns (seconds later).
func confirmWindow(cadence time.Duration) time.Duration {
	return cadence + cadence/2
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
	// pr_merge.go); mergeLocks runs one merge, state change or description edit of a pull
	// request at a time. reviews and comments answer an identical review or comment sent
	// again soon (pr_review.go).
	reverts    writeMemos[fullKey, RevertResult]
	merges     writeMemos[fullKey, mergeMemo]
	mergeLocks keyLocks
	reviews    writeMemos[writeKey, SubmittedReview]
	comments   writeMemos[writeKey, PostedComment]
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
	return c.adoptWith(k, d, true, time.Time{})
}

// adoptConfirmed stores d (loaded from SQLite and validated against a live poll) as
// fresh and confirmed at confirmed unless an entry already exists.
func (c *fullCache) adoptConfirmed(k fullKey, d FullPullRequest, confirmed time.Time) fullEntry {
	return c.adoptWith(k, d, false, confirmed)
}

func (c *fullCache) adoptWith(k fullKey, d FullPullRequest, stale bool, confirmed time.Time) fullEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.m[k]; ok {
		return *e
	}
	e := &fullEntry{d: d, stale: stale, confirmed: confirmed}
	c.putLocked(k, e)
	return *e
}

// markWritten marks k stale and known wrong: reads wait for the next fetch.
func (c *fullCache) markWritten(k fullKey) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.m[k]; ok {
		e.stale, e.written = true, true
	}
}

// patch updates a copy of k's cached detail in place when present and marks the entry
// fresh and confirmed at now so an immediate FullPullRequest read serves it with zero
// GitHub round-trips. Returns the patched copy and true when k was cached in memory.
func (c *fullCache) patch(k fullKey, now time.Time, mutate func(*FullPullRequest)) (FullPullRequest, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok {
		return FullPullRequest{}, false
	}
	d := e.d
	mutate(&d)
	d.FetchedAt = now
	d.LastError, d.FetchFailed, d.Refreshing = "", false, false
	c.m[k] = &fullEntry{d: d, confirmed: now}
	return d, true
}

// fail records that a fetch of k failed at now; it reports whether that is news: the
// entry exists and its last fetch had not failed.
func (c *fullCache) fail(k fullKey, err error, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok {
		return false
	}
	news := e.failure == nil
	e.failure, e.failedAt, e.written = err, now, false
	return news
}

// applyPoll records what a poll saw:
//   - A fresh entry whose only change is check counts while checks remain PENDING (no new
//     failure) has its summary Checks patched in place and is marked checksStale (so an
//     open panel refreshes only checks.graphql rather than the full PullRequestFull doc).
//   - Any other fresh entry whose fingerprint moved goes stale (returned).
//   - Every unchanged fresh entry in fps is confirmed at now when confirmable.
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
		case pendingCheckCountsOnly(e.d.PullRequest, f):
			e.d.PullRequest.Checks = f.Checks
			e.checksStale = true
			out = append(out, k)
		case fingerprintMoved(e.d.PullRequest, f):
			e.stale, e.checksStale = true, false
			out = append(out, k)
		case confirmable(e.d) && !e.checksStale:
			e.confirmed = now
		}
	}
	return out
}

// pendingCheckCountsOnly reports whether f differs from p solely in its check counts
// while checks remain PENDING with no new failure. Patching the summary counts in place
// avoids refetching the whole FullPullRequest while CI ticks; once CI settles or a check
// fails (or any non-check field moves), the detail goes stale and refetches so check-run
// rows stay accurate.
func pendingCheckCountsOnly(p PullRequest, f prFingerprint) bool {
	if !p.UpdatedAt.Equal(f.UpdatedAt) || p.State != f.State || p.HeadSHA != f.HeadSHA {
		return false
	}
	if !f.HasChecks || p.Checks == f.Checks {
		return false
	}
	return p.Checks.State == RollupPending &&
		f.Checks.State == RollupPending &&
		f.Checks.Pending > 0 &&
		f.Checks.Failed == p.Checks.Failed
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

// FullPullRequest implements Service. It waits for GitHub only with nothing cached, for
// a refresh, and right after this store's own write; any other copy comes back at once
// (staleFirst). A decision reads currentFull instead.
func (s *Store) FullPullRequest(ctx context.Context, slug string, number int, refresh bool) (FullPullRequest, error) {
	k, err := fullKeyOf(slug, number)
	if err != nil {
		return FullPullRequest{}, err
	}
	e, ok := s.cachedFull(ctx, k)
	switch {
	case !ok, refresh, e.written:
		return s.fetchOrCached(ctx, k, e, ok)
	case s.current(e):
		return e.d, nil
	}
	return s.staleFirst(k, e), nil
}

// currentFull returns k's detail for a decision (merge, revert, a state change): the
// cached copy only while it is current, else a fetch it waits for. A failed fetch still
// answers with the cached copy (FetchFailed): GitHub's own checks stand behind the
// mutation, and a caller that must be sure fetches with fetchFullJob.
func (s *Store) currentFull(ctx context.Context, k fullKey) (FullPullRequest, error) {
	e, ok := s.cachedFull(ctx, k)
	if ok && s.current(e) {
		return e.d, nil
	}
	return s.fetchOrCached(ctx, k, e, ok)
}

// current reports whether e needs no fetch now.
func (s *Store) current(e fullEntry) bool {
	cfg := s.config()
	return e.serves(s.opts.Now(), cfg.PollInterval, s.pollCadence(cfg))
}

// fetchOrCached fetches k and waits; if that fails, e (ok: there is one) answers with
// the error in LastError.
func (s *Store) fetchOrCached(ctx context.Context, k fullKey, e fullEntry, ok bool) (FullPullRequest, error) {
	d, err := s.fetchFullJob(ctx, k)
	if err != nil {
		if ok && ctx.Err() == nil {
			return failedCopy(e.d, err), nil
		}
		return FullPullRequest{}, err
	}
	return d, nil
}

// failedCopy is d served because fetching it failed with err.
func failedCopy(d FullPullRequest, err error) FullPullRequest {
	d.LastError, d.FetchFailed = err.Error(), true
	return d
}

// staleFirst answers a read of e, which is not current, without waiting: e's copy, with
// a fetch queued (Refreshing) unless the last one failed moments ago or the store is
// paused. A copy whose fetch failed says so (FetchFailed) until a fetch lands.
func (s *Store) staleFirst(k fullKey, e fullEntry) FullPullRequest {
	d := e.d
	if e.failure != nil {
		d = failedCopy(d, e.failure)
		if s.opts.Now().Sub(e.failedAt) < fullRetryAfter {
			return d
		}
	}
	if err := s.refreshFull(k); err != nil {
		return failedCopy(e.d, err)
	}
	d.Refreshing = true
	return d
}

// cachedFull returns the cached entry of k from memory or, failing that, SQLite.
// When loading from SQLite, if a live poll has already confirmed that the pull request
// has not changed since row.FetchedAt (and no local write or move invalidated it), the
// row is adopted as fresh and confirmed so no redundant GraphQL fetch is triggered.
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
	s.summaries.put(k, row.PullRequest)
	if fp, polledAt, ok := s.summaries.polledFingerprint(k); ok &&
		!polledAt.Before(row.FetchedAt) &&
		confirmable(row) &&
		!s.moved.movedSince(k, row.FetchedAt) &&
		!s.moved.writtenSince(k, row.FetchedAt) &&
		prMatchesFingerprint(row.PullRequest, fp) {
		return s.full.adoptConfirmed(k, row, polledAt), true
	}
	return s.full.adopt(k, row), true
}

// fullJobID identifies k's fetch: a read that waits and a background refresh coalesce.
func fullJobID(k fullKey) string { return "full|" + k.String() }

// fetchFullJob fetches k on the worker and waits; it returns GitHub's error, if any.
func (s *Store) fetchFullJob(ctx context.Context, k fullKey) (FullPullRequest, error) {
	submitted := s.opts.Now()
	return submitRead(ctx, s, fullJobID(k), func(ctx context.Context) (FullPullRequest, error) {
		return s.runFullFetch(ctx, k, submitted, false, true)
	})
}

// refreshFull queues k's fetch with nobody waiting for it; while the store is paused it
// queues nothing and returns why. PullRequestDetailUpdated reports the end.
func (s *Store) refreshFull(k fullKey) error {
	submitted := s.opts.Now()
	return s.submitBackground(&job{kind: jobFunc, id: fullJobID(k), run: func(ctx context.Context) (any, error) {
		return s.runFullFetch(ctx, k, submitted, true, false)
	}})
}

// runFullFetch is a detail fetch on the worker, asked for at submitted. Jobs with the
// same id coalesce only while queued, so a job that finds a fetch ended since it was
// submitted (one that was already running) takes that fetch's outcome instead of
// sending another request. background: a read was answered Refreshing and waits for the
// event, which goes out however this ends. forceFull forces PullRequestFull even when
// only checksStale is set (explicit refresh or post-write read).
func (s *Store) runFullFetch(ctx context.Context, k fullKey, submitted time.Time, background, forceFull bool) (FullPullRequest, error) {
	e, hasEntry := s.full.entry(k)
	if hasEntry {
		fetched := !e.stale && !e.checksStale && e.d.FetchedAt.After(submitted)
		failed := e.failure != nil && e.failedAt.After(submitted)
		if fetched || failed {
			if background {
				publish(s, PullRequestDetailUpdated{Slug: k.slug, Number: k.number, Unchanged: true})
			}
			if failed {
				return FullPullRequest{}, e.failure
			}
			return e.d, nil
		}
	}
	start := s.opts.Now()
	var (
		d     FullPullRequest
		err   error
		query = queryPullRequestFull
	)
	if !forceFull && hasEntry && e.checksStale && !e.stale && !e.written && e.d.PullRequest.HeadSHA != "" {
		query = queryChecks
		d, err = s.fetchChecksOnly(ctx, k, e.d, background)
		if errors.Is(err, ErrNotFound) {
			// The commit may have been force-pushed away; fall back to full detail fetch.
			query = queryPullRequestFull
			d, err = s.fetchFull(ctx, k, background)
		}
	} else {
		d, err = s.fetchFull(ctx, k, background)
	}
	end := s.opts.Now()
	attrs := []any{"pr", k.String(), "query", query, "queue_wait", start.Sub(submitted).Round(time.Millisecond).String(),
		"fetch", end.Sub(start).Round(time.Millisecond).String(), "background", background}
	if err != nil {
		attrs = append(attrs, "err", err)
	}
	s.log.Info("gh pull request detail fetch", attrs...)
	if err != nil && ctx.Err() == nil {
		if s.full.fail(k, err, end) || background {
			publish(s, PullRequestDetailUpdated{Slug: k.slug, Number: k.number, Unchanged: true})
		}
	}
	return d, err
}

// fetchChecksOnly refreshes only the commit's check-run rows (checks.graphql) for a
// checksStale entry, keeping the panel's Checks list up to date without refetching the
// full pull_request_full document (comments, commits, reviews, review threads).
func (s *Store) fetchChecksOnly(ctx context.Context, k fullKey, base FullPullRequest, announce bool) (FullPullRequest, error) {
	owner, name := splitSlug(k.slug)
	data, err := s.call(ctx, queryChecks, map[string]any{"owner": owner, "name": name, "ref": base.PullRequest.HeadSHA, "after": nil})
	if err != nil {
		return FullPullRequest{}, err
	}
	page, err := decodeChecks(data)
	if err != nil {
		return FullPullRequest{}, err
	}
	d := base
	d.LastError, d.FetchFailed = "", false
	if page.Rollup.Total > 0 || page.Rollup.State != "" {
		d.PullRequest.Checks = page.Rollup
	}
	runs, next := page.Runs, page.Next
	for p := 1; next.HasNextPage && next.EndCursor != "" && p < s.opts.MaxPages; p++ {
		data, err := s.call(ctx, queryChecks, map[string]any{"owner": owner, "name": name, "ref": d.PullRequest.HeadSHA, "after": next.EndCursor})
		var cp checksPage
		if err == nil {
			cp, err = decodeChecks(data)
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
	s.summaries.put(k, d.PullRequest)
	if err := s.cache.saveActivity(ctx, activityFull+k.String(), d.FetchedAt, d); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	switch {
	case had && !sameFull(prev.d, d):
		publish(s, PullRequestDetailUpdated{Slug: k.slug, Number: k.number})
	case announce || prev.failure != nil:
		publish(s, PullRequestDetailUpdated{Slug: k.slug, Number: k.number, Unchanged: true})
	}
	return d, nil
}

// fetchFull runs on the worker: the detail request, more check pages when there are
// over 100 checks, then the cache and PullRequestDetailUpdated: when it changed, when it
// ends a failure clients were told about, or always with announce. A failed checks page
// keeps the checks fetched so far: ChecksTruncated and LastError say so.
func (s *Store) fetchFull(ctx context.Context, k fullKey, announce bool) (FullPullRequest, error) {
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
			cp, err = decodeChecks(data)
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
	s.summaries.put(k, d.PullRequest)
	if err := s.cache.saveActivity(ctx, activityFull+k.String(), d.FetchedAt, d); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	switch {
	case had && !sameFull(prev.d, d):
		publish(s, PullRequestDetailUpdated{Slug: k.slug, Number: k.number})
	case announce || prev.failure != nil:
		publish(s, PullRequestDetailUpdated{Slug: k.slug, Number: k.number, Unchanged: true})
	}
	return d, nil
}

// staleFullDetails is the poll's hook: cached details whose pull request's fingerprint
// moved go stale (or have pending check counts patched in place), and clients hear about
// it; the others it saw are confirmed.
func (s *Store) staleFullDetails(fps []prFingerprint) {
	for _, k := range s.full.applyPoll(fps, s.opts.Now()) {
		if e, ok := s.full.entry(k); ok && e.stale {
			s.reviewers.invalidatePR(k)
		}
		publish(s, PullRequestDetailUpdated{Slug: k.slug, Number: k.number})
	}
}

// invalidateFull marks a cached detail wrong after a change the store made and tells
// clients to re-read; that read waits for the fetch, so it shows the change.
func (s *Store) invalidateFull(k fullKey) {
	s.full.markWritten(k)
	s.moved.markWrite(k, s.opts.Now(), s.opts.DetailTTL)
	s.reviewers.invalidatePR(k)
	publish(s, PullRequestDetailUpdated{Slug: k.slug, Number: k.number})
}

// patchFull updates k's cached detail in place from a mutation response, marks it fresh
// and confirmed so the panel's immediate GetPullRequestDetail read returns the patched
// copy in 0 ms with 0 extra GitHub round-trips, persists it to SQLite, updates the
// summary cache, and publishes PullRequestDetailUpdated. When k is not cached in memory
// it falls back to invalidateFull so any SQLite row is not trusted and clients still
// hear PullRequestDetailUpdated.
func (s *Store) patchFull(ctx context.Context, k fullKey, mutate func(*FullPullRequest)) {
	now := s.opts.Now()
	d, ok := s.full.patch(k, now, mutate)
	if !ok {
		s.invalidateFull(k)
		return
	}
	s.summaries.put(k, d.PullRequest)
	if err := s.cache.saveActivity(ctx, activityFull+k.String(), d.FetchedAt, d); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	publish(s, PullRequestDetailUpdated{Slug: k.slug, Number: k.number})
}

// advanceUpdatedAt updates *dst to t when t is non-zero and newer (or *dst is zero).
func advanceUpdatedAt(dst *time.Time, t time.Time) {
	if !t.IsZero() && (dst.IsZero() || t.After(*dst)) {
		*dst = t
	}
}

// submitFunc queues run as an on-demand job (coalescing with a queued job of the same
// id) and returns its result.
func submitFunc[T any](ctx context.Context, s *Store, id string, run func(context.Context) (T, error)) (T, error) {
	return submitJob(ctx, s, id, false, run)
}

// submitRead is submitFunc for a read: nobody left waiting takes it off the queue.
func submitRead[T any](ctx context.Context, s *Store, id string, run func(context.Context) (T, error)) (T, error) {
	return submitJob(ctx, s, id, true, run)
}

func submitJob[T any](ctx context.Context, s *Store, id string, read bool, run func(context.Context) (T, error)) (T, error) {
	var zero T
	res := s.submit(ctx, &job{kind: jobFunc, id: id, read: read, run: func(ctx context.Context) (any, error) { return run(ctx) }})
	if res.err != nil {
		return zero, res.err
	}
	v, ok := res.value.(T)
	if !ok {
		return zero, fmt.Errorf("gh: job %s returned %T", id, res.value)
	}
	return v, nil
}
