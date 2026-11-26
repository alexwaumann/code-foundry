package gh

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"
)

// Foreground fast-poll loop for actively viewed hot open pull requests
// (docs/notes/perf-gh-hot-pr-fast-poll.md).
//
// While the GUI is in PresenceForeground, a pull request opened in the detail panel
// (FullPullRequest) or mutated locally (patchFull / invalidateFull) holds a bounded hot
// lease (DefaultHotLease). If its cached detail is open and actively changing or waiting
// on GitHub computation (pending check rollup, UNKNOWN mergeability/merge state, or
// within DefaultHotMutateWindow of a local mutation), the primary worker sends one cheap
// PullRequestHot (nodes(ids:), cost 1) query every HotPollInterval (default 15 s) for up
// to maxHotPRs pull requests.
//
// Invariants:
//   - Zero wasted polls: when no pull request is eligible, or presence != PresenceForeground,
//     no hot poll is scheduled or sent.
//   - Anti-duplication: skipped when a regular poll is due within min(HotPollInterval/3, 3s),
//     and reset to now + HotPollInterval whenever a regular poll finishes.
//   - Primary-worker scheduled job: s.scheduled = true so yield.go lets user-waited clicks
//     ahead of it and read_lane.go lets user-waited reads overlap with it; never runs on the
//     read lane and never spends gapAllowance tokens.
//   - Lock order: hotPRs.mu, fullCache.mu, and Store.mu are strictly leaf locks (never nested).

const (
	// maxHotPRs caps how many pull request node IDs one PullRequestHot batch carries.
	maxHotPRs = 8
	// hotLeaseMax bounds the in-memory hot lease map alongside fullCacheMax.
	hotLeaseMax = fullCacheMax
	// hotSkipMax caps the anti-duplication window before an imminent full poll.
	hotSkipMax = 3 * time.Second
)

type hotLease struct {
	until     time.Time
	touchedAt time.Time
	mutatedAt time.Time
}

type hotLeasedKey struct {
	key   fullKey
	lease hotLease
}

type hotCandidate struct {
	key       fullKey
	id        string
	touchedAt time.Time
}

// hotPRs tracks the bounded set of recently viewed or mutated pull requests that may
// qualify for foreground fast-polling. The zero value is ready to use.
type hotPRs struct {
	mu sync.Mutex
	m  map[fullKey]hotLease
}

// touch refreshes k's hot lease at now. When mutated is true, mutatedAt is also stamped
// to now; otherwise any existing mutatedAt is preserved.
func (h *hotPRs) touch(k fullKey, now time.Time, mutated bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.m == nil {
		h.m = map[fullKey]hotLease{}
	}
	l := h.m[k]
	l.until = now.Add(DefaultHotLease)
	l.touchedAt = now
	if mutated {
		l.mutatedAt = now
	}
	h.m[k] = l
	for key, cur := range h.m {
		if !now.Before(cur.until) {
			delete(h.m, key)
		}
	}
	for len(h.m) > hotLeaseMax {
		var oldest fullKey
		first := true
		for key, cur := range h.m {
			if key != k && (first || cur.touchedAt.Before(h.m[oldest].touchedAt)) {
				oldest, first = key, false
			}
		}
		if first {
			break
		}
		delete(h.m, oldest)
	}
}

// drop immediately removes k from the hot lease map (e.g. once merged or closed).
func (h *hotPRs) drop(k fullKey) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.m, k)
}

// active returns all non-expired leases at now, pruning expired entries in place.
func (h *hotPRs) active(now time.Time) []hotLeasedKey {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.m) == 0 {
		return nil
	}
	var out []hotLeasedKey
	for k, l := range h.m {
		if !now.Before(l.until) {
			delete(h.m, k)
			continue
		}
		out = append(out, hotLeasedKey{key: k, lease: l})
	}
	return out
}

// eligibleHot evaluates leases against the cached detail entries under c.mu. Entries
// that are no longer open are returned in closed so the caller can drop them from hotPRs
// without nesting locks.
func (c *fullCache) eligibleHot(leases []hotLeasedKey, now time.Time) (candidates []hotCandidate, closed []fullKey) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, item := range leases {
		e, ok := c.m[item.key]
		if !ok {
			continue
		}
		p := e.d.PullRequest
		if p.State != PullRequestOpen {
			closed = append(closed, item.key)
			continue
		}
		if p.ID == "" || e.stale || e.written {
			continue
		}
		pendingChecks := p.Checks.State == RollupPending
		unknownMerge := p.Mergeable == MergeableUnknown || p.MergeStateStatus == "UNKNOWN"
		recentlyMutated := !item.lease.mutatedAt.IsZero() && now.Sub(item.lease.mutatedAt) < DefaultHotMutateWindow
		if !pendingChecks && !unknownMerge && !recentlyMutated {
			continue
		}
		candidates = append(candidates, hotCandidate{
			key:       item.key,
			id:        p.ID,
			touchedAt: item.lease.touchedAt,
		})
	}
	return candidates, closed
}

// hotInterval returns the effective foreground hot-poll interval, floored by MinGap when
// enabled (HotPollInterval > 0). Returns 0 when disabled.
func (s *Store) hotInterval() time.Duration {
	if s.opts.HotPollInterval <= 0 {
		return 0
	}
	return max(s.opts.HotPollInterval, s.opts.MinGap)
}

// hasEligibleHot reports whether at least one leased PR is eligible for a hot poll at now.
func (s *Store) hasEligibleHot(now time.Time) bool {
	leases := s.hot.active(now)
	if len(leases) == 0 {
		return false
	}
	candidates, closed := s.full.eligibleHot(leases, now)
	for _, k := range closed {
		s.hot.drop(k)
	}
	return len(candidates) > 0
}

// eligibleHotTargets returns up to maxHotPRs unique eligible hot PR candidates,
// ordered most recently touched first.
func (s *Store) eligibleHotTargets(now time.Time) []hotCandidate {
	leases := s.hot.active(now)
	if len(leases) == 0 {
		return nil
	}
	candidates, closed := s.full.eligibleHot(leases, now)
	for _, k := range closed {
		s.hot.drop(k)
	}
	if len(candidates) == 0 {
		return nil
	}
	slices.SortFunc(candidates, func(a, b hotCandidate) int {
		if a.touchedAt.After(b.touchedAt) {
			return -1
		}
		if a.touchedAt.Before(b.touchedAt) {
			return 1
		}
		if c := cmp.Compare(a.key.slug, b.key.slug); c != 0 {
			return c
		}
		return cmp.Compare(a.key.number, b.key.number)
	})
	out := make([]hotCandidate, 0, min(len(candidates), maxHotPRs))
	seen := make(map[string]bool, min(len(candidates), maxHotPRs))
	for _, cand := range candidates {
		if seen[cand.id] {
			continue
		}
		seen[cand.id] = true
		out = append(out, cand)
		if len(out) >= maxHotPRs {
			break
		}
	}
	return out
}

// eligibleHotIDs returns up to maxHotPRs unique GraphQL node IDs of eligible hot PRs,
// ordered most recently touched first.
func (s *Store) eligibleHotIDs(now time.Time) []string {
	targets := s.eligibleHotTargets(now)
	if len(targets) == 0 {
		return nil
	}
	ids := make([]string, len(targets))
	for i, t := range targets {
		ids[i] = t.id
	}
	return ids
}

// touchHot refreshes k's hot lease (or drops it when p is closed/merged) and arms
// hotNext when transitioning into an eligible foreground hot set.
func (s *Store) touchHot(k fullKey, p PullRequest, mutated bool) {
	if p.State != "" && p.State != PullRequestOpen {
		s.hot.drop(k)
		return
	}
	now := s.opts.Now()
	s.hot.touch(k, now, mutated)
	s.armHotPoll(now)
}

// touchHotMutated refreshes k's hot lease with mutatedAt stamped after invalidateFull,
// dropping k immediately if the cached entry is already closed or merged.
func (s *Store) touchHotMutated(k fullKey) {
	if e, ok := s.full.entry(k); ok && e.d.PullRequest.State != "" && e.d.PullRequest.State != PullRequestOpen {
		s.hot.drop(k)
		return
	}
	now := s.opts.Now()
	s.hot.touch(k, now, true)
	s.armHotPoll(now)
}

func (s *Store) armHotPoll(now time.Time) {
	hotInt := s.hotInterval()
	if hotInt <= 0 || !s.hasEligibleHot(now) {
		return
	}
	wake := false
	s.mu.Lock()
	if s.hotNext.IsZero() {
		s.hotNext = now.Add(hotInt)
		wake = true
	}
	s.mu.Unlock()
	if wake && s.presence() == PresenceForeground {
		s.nudge()
	}
}

// nextScheduledLocked chooses between jobPoll and jobHotPoll when auth is good.
// Called with s.mu held.
func (s *Store) nextScheduledLocked(now time.Time, pres Presence, hotEligible bool) (*job, time.Time) {
	pollAt := laterOf(s.pollNext, s.pauseUntil)
	if !hotEligible {
		// Clear hotNext when foreground has no eligible hot PRs so the next hot PR waits
		// a full HotPollInterval instead of firing immediately on a stale timestamp.
		// Keep hotNext while away (Background/None) so returning to foreground after
		// >= HotPollInterval polls promptly.
		if pres == PresenceForeground {
			s.hotNext = time.Time{}
		}
		return &job{kind: jobPoll}, pollAt
	}
	hotInt := s.hotInterval()
	if s.hotNext.IsZero() {
		s.hotNext = now.Add(hotInt)
	}
	hotAt := laterOf(s.hotNext, s.pauseUntil)
	skipWindow := min(hotInt/3, hotSkipMax)
	if !pollAt.After(laterOf(hotAt, now).Add(skipWindow)) {
		return &job{kind: jobPoll}, pollAt
	}
	return &job{kind: jobHotPoll}, hotAt
}

// ---- PullRequestHot wire decode and application --------------------------------

type hotNodeJSON struct {
	fingerprintJSON
	IsDraft          bool   `json:"isDraft"`
	Mergeable        string `json:"mergeable"`
	MergeStateStatus string `json:"mergeStateStatus"`
}

type hotNode struct {
	fp               prFingerprint
	Draft            bool
	Mergeable        Mergeable
	MergeStateStatus MergeStateStatus
}

func decodeHotNodes(data []byte) ([]hotNode, error) {
	var env struct {
		Nodes []*hotNodeJSON `json:"nodes"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("decode pull request hot: %w", err)
	}
	out := make([]hotNode, 0, len(env.Nodes))
	for _, n := range env.Nodes {
		if n == nil || n.ID == "" || (n.Typename != "" && n.Typename != "PullRequest") {
			continue
		}
		fps := mapFingerprints([]fingerprintJSON{n.fingerprintJSON}, true)
		if len(fps) == 0 {
			continue
		}
		out = append(out, hotNode{
			fp:               fps[0],
			Draft:            n.IsDraft,
			Mergeable:        Mergeable(n.Mergeable),
			MergeStateStatus: MergeStateStatus(n.MergeStateStatus),
		})
	}
	return out, nil
}

func hotMetaEqual(p PullRequest, h hotNode) bool {
	return p.Draft == h.Draft && p.Mergeable == h.Mergeable && p.MergeStateStatus == h.MergeStateStatus
}

func hotMatches(p PullRequest, h hotNode) bool {
	return prMatchesFingerprint(p, h.fp) && hotMetaEqual(p, h)
}

func hotPendingCheckCountsOnly(p PullRequest, h hotNode) bool {
	return pendingCheckCountsOnly(p, h.fp) && hotMetaEqual(p, h)
}

func hotMoved(p PullRequest, h hotNode) bool {
	return fingerprintMoved(p, h.fp) || !hotMetaEqual(p, h)
}

// hotMergeabilityResolved reports whether h observed resolved mergeability/merge state
// for an entry p that still had UNKNOWN.
func hotMergeabilityResolved(p PullRequest, h hotNode) bool {
	return (p.Mergeable == MergeableUnknown && h.Mergeable != "" && h.Mergeable != MergeableUnknown) ||
		(p.MergeStateStatus == "UNKNOWN" && h.MergeStateStatus != "" && h.MergeStateStatus != "UNKNOWN")
}

// hotMetaOnlyRegressedToUnknown reports whether h differs from p solely by GitHub
// temporarily dropping resolved mergeability/mergeStateStatus back to UNKNOWN (e.g.
// after a base-branch push without bumping updatedAt). Keep the resolved copy intact
// rather than triggering a PullRequestFull that flickers the panel to UNKNOWN.
func hotMetaOnlyRegressedToUnknown(p PullRequest, h hotNode) bool {
	if fingerprintMoved(p, h.fp) || p.Draft != h.Draft {
		return false
	}
	mergeRegressed := p.Mergeable != h.Mergeable && h.Mergeable == MergeableUnknown
	stateRegressed := p.MergeStateStatus != h.MergeStateStatus && h.MergeStateStatus == "UNKNOWN"
	mergeOK := p.Mergeable == h.Mergeable || mergeRegressed
	stateOK := p.MergeStateStatus == h.MergeStateStatus || stateRegressed
	return (mergeRegressed || stateRegressed) && mergeOK && stateOK
}

type hotChange struct {
	key         fullKey
	stale       bool
	checksStale bool
	pr          PullRequest
	fp          prFingerprint
}

// applyHotAt applies a PullRequestHot response against cached full entries under c.mu,
// following the same fpSeq causality rules as applyPollAt plus draft/mergeability checks.
func (c *fullCache) applyHotAt(nodes []hotNode, fpSeq uint64, now time.Time) (changes []hotChange, closed []fullKey) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) == 0 || len(nodes) == 0 {
		return nil, nil
	}
	byID := make(map[string]hotNode, len(nodes))
	for _, n := range nodes {
		byID[n.fp.ID] = n
	}
	movedAny := false
	for k, e := range c.m {
		h, ok := byID[e.d.PullRequest.ID]
		if !ok {
			continue
		}
		if h.fp.State != PullRequestOpen {
			closed = append(closed, k)
		}
		if e.stale {
			if fpSeq > 0 && hotMoved(e.d.PullRequest, h) {
				c.recordMovedSeqLocked(k, fpSeq)
				movedAny = true
			}
			continue
		}
		switch {
		case fpSeq > 0 && e.fetchSeq > fpSeq && e.d.PullRequest.UpdatedAt.After(h.fp.UpdatedAt):
			// Strictly newer read-lane fetch: leave untouched.
		case fpSeq > 0 && e.fetchSeq > fpSeq && e.d.PullRequest.UpdatedAt.Equal(h.fp.UpdatedAt):
			switch {
			case hotMatches(e.d.PullRequest, h):
				if confirmable(e.d) && !e.checksStale {
					e.confirmed = now
				}
			case hotMergeabilityResolved(e.d.PullRequest, h):
				e.stale, e.checksStale = true, false
				c.recordMovedSeqLocked(k, fpSeq)
				movedAny = true
				changes = append(changes, hotChange{key: k, stale: true, fp: h.fp})
			case e.d.PullRequest.Checks != h.fp.Checks:
				e.checksStale = true
				changes = append(changes, hotChange{key: k, checksStale: true, pr: e.d.PullRequest, fp: h.fp})
			}
		case hotPendingCheckCountsOnly(e.d.PullRequest, h):
			e.d.PullRequest.Checks = h.fp.Checks
			e.checksStale = true
			changes = append(changes, hotChange{key: k, checksStale: true, pr: e.d.PullRequest, fp: h.fp})
		case hotMetaOnlyRegressedToUnknown(e.d.PullRequest, h):
			// Avoid flickering a resolved entry back to UNKNOWN while GitHub recomputes.
		case hotMoved(e.d.PullRequest, h):
			e.stale, e.checksStale = true, false
			if fpSeq > 0 {
				c.recordMovedSeqLocked(k, fpSeq)
				movedAny = true
			}
			changes = append(changes, hotChange{key: k, stale: true, fp: h.fp})
		case confirmable(e.d) && !e.checksStale:
			e.confirmed = now
		}
	}
	if movedAny {
		c.pruneMovedSeqLocked()
	}
	return changes, closed
}

// hotPoll runs one foreground PullRequestHot request on the primary worker.
func (s *Store) hotPoll(ctx context.Context) {
	if s.opts.HotPollInterval <= 0 || s.presence() != PresenceForeground {
		return
	}
	start := s.opts.Now()
	targets := s.eligibleHotTargets(start)
	if len(targets) == 0 {
		s.mu.Lock()
		s.hotNext = time.Time{}
		s.hotFailures = 0
		s.mu.Unlock()
		return
	}
	ids := make([]string, len(targets))
	for i, t := range targets {
		ids[i] = t.id
	}
	data, fpSeq, hotStart, err := s.callMeta(ctx, queryPullRequestHot, map[string]any{"ids": ids})
	if ctx.Err() != nil {
		return
	}
	var partial *PartialError
	if err != nil && !errors.As(err, &partial) {
		s.hotPollFailed(err)
		return
	}
	nodes, err := decodeHotNodes(data)
	if err != nil {
		s.hotPollFailed(err)
		return
	}
	if partial != nil {
		if e := partial.Unplaced(); e != nil {
			s.log.Warn("gh hot poll partial errors", "err", e)
		}
	}
	s.applyHotPoll(targets, nodes, partial == nil, fpSeq, hotStart, start)
}

func (s *Store) hotPollFailed(err error) {
	now := s.opts.Now()
	hotInt := s.hotInterval()
	s.mu.Lock()
	if hotInt <= 0 {
		s.hotNext = time.Time{}
	} else if isGlobal(err) && (s.authBad || now.Before(s.pauseUntil)) {
		// Global pause or auth check holds it; reset next slot after hotInt so a short
		// pause still spaces cleanly.
		s.hotNext = now.Add(hotInt)
	} else {
		s.hotFailures++
		s.hotNext = now.Add(backoff(hotInt, s.opts.MaxBackoff, s.hotFailures, s.opts.Rand()))
	}
	s.mu.Unlock()
	if !isRefused(err) {
		s.log.Warn("gh hot poll failed", "err", err)
	}
}

func (s *Store) applyHotPoll(targets []hotCandidate, nodes []hotNode, complete bool, fpSeq uint64, hotStart, start time.Time) {
	now := s.opts.Now()
	snap := s.Snapshot()
	fps := make([]prFingerprint, 0, len(nodes))
	returnedIDs := make(map[string]bool, len(nodes))
	for _, n := range nodes {
		returnedIDs[n.fp.ID] = true
		fps = append(fps, n.fp)
		if n.fp.State != PullRequestOpen && n.fp.Repo != "" && n.fp.Number > 0 {
			s.hot.drop(fullKey{n.fp.Repo, n.fp.Number})
			if localSlug := snap.LocalRepo(n.fp.Repo); localSlug != n.fp.Repo {
				s.hot.drop(fullKey{localSlug, n.fp.Number})
			}
		}
	}
	if complete {
		// Drop deleted or transferred PRs (null nodes) so we do not re-poll them until lease expiry.
		for _, t := range targets {
			if !returnedIDs[t.id] {
				s.hot.drop(t.key)
			}
		}
	}
	s.summaries.putFingerprints(snap, fps, hotStart)

	changes, closed := s.full.applyHotAt(nodes, fpSeq, now)
	for _, k := range closed {
		s.hot.drop(k)
	}
	for _, ch := range changes {
		if ch.checksStale {
			s.summaries.put(ch.key, ch.pr)
		}
		if ch.stale {
			s.reviewers.invalidatePR(ch.key)
		}
		if !s.prDetails.newerThan(ch.key, fpSeq, ch.fp) {
			s.moved.markSeq(ch.key, now, fpSeq, s.opts.DetailTTL)
		}
		if localSlug := snap.LocalRepo(ch.key.slug); localSlug != ch.key.slug {
			lk := fullKey{localSlug, ch.key.number}
			if !s.prDetails.newerThan(lk, fpSeq, ch.fp) {
				s.moved.markSeq(lk, now, fpSeq, s.opts.DetailTTL)
			}
		}
		publish(s, PullRequestDetailUpdated{Slug: ch.key.slug, Number: ch.key.number})
	}

	end := s.opts.Now()
	hotInt := s.hotInterval()
	s.mu.Lock()
	s.hotFailures = 0
	if hotInt > 0 {
		s.hotNext = end.Add(hotInt)
	} else {
		s.hotNext = time.Time{}
	}
	next := s.hotNext.Sub(end)
	s.mu.Unlock()
	s.log.Debug("gh hot poll", "asked", len(targets), "returned", len(nodes), "changed", len(changes),
		"dur", end.Sub(start).Round(time.Millisecond).String(),
		"next_in", max(0, next).Round(time.Second).String())
}
