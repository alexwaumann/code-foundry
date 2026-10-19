package gh

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Watched pull requests (docs/notes/gh-events-3-pr-wake.md). A thread wake subscription
// to a pull request needs the poll to keep seeing it for as long as the subscription
// lives, whoever wrote it and however long the authored dashboard is. The daemon hands
// the store the set (WatchPullRequests); planPoll folds each one in as a watched branch
// (its head branch, without BranchWatch's expiry), and the branch's list keeps it
// whatever its author or fork (a branch list otherwise keeps only the viewer's own pull
// requests). The cost is one more branch block in the batched poll query per watched
// pull request whose branch is not watched already; nothing is added to the cadence.

// PullRequestRef names one pull request: Slug is "owner/name" (lower case).
type PullRequestRef struct {
	Slug   string
	Number int
}

// String is "owner/name#123".
func (r PullRequestRef) String() string { return r.Slug + "#" + strconv.Itoa(r.Number) }

// prWatch is one watched pull request: its head branch once known, and when an unknown
// one was last looked up on GitHub (resolveWatchedHeads).
type prWatch struct {
	head  string
	tried time.Time
}

// WatchPullRequests replaces the set of pull requests the poll keeps in scope. Each
// one's head branch is polled as a watched branch while it is in the set, with no
// expiry, and keeps it in its list whatever its author. A head branch the store does
// not know yet is looked up at the next poll (one request, retried at most every
// BranchWatch). A pull request new to the set brings the next poll forward, as a
// newly watched branch does.
func (s *Store) WatchPullRequests(refs []PullRequestRef) error {
	next := map[PullRequestRef]prWatch{}
	for _, r := range refs {
		slug, err := NormalizeSlug(r.Slug)
		if err != nil {
			return err
		}
		if r.Number <= 0 {
			return fmt.Errorf("%w: pull request number %d", ErrInvalidArgument, r.Number)
		}
		next[PullRequestRef{slug, r.Number}] = prWatch{}
	}
	now := s.opts.Now()
	s.mu.Lock()
	added := false
	for r := range next {
		if w, ok := s.prWatches[r]; ok {
			next[r] = w
			continue
		}
		added = true
	}
	s.prWatches = next
	if added {
		s.pollSoonLocked(now)
	}
	s.mu.Unlock()
	if added {
		s.nudge()
	}
	s.log.Debug("gh watched pull requests", "count", len(next))
	return nil
}

// watchedPullRequests is the watched set with each head branch, filled from the cached
// lists where unknown. Called by planPoll.
func (s *Store) watchedPullRequests() map[PullRequestRef]string {
	s.mu.Lock()
	refs := maps.Clone(s.prWatches)
	s.mu.Unlock()
	out := map[PullRequestRef]string{}
	var known map[PullRequestRef]PullRequest
	for r, w := range refs {
		head := w.head
		if head == "" {
			if known == nil {
				known = s.cachedByRef()
			}
			head = known[r].HeadRef
		}
		out[r] = head
	}
	return out
}

// resolveWatchedHeads finds the head branch of each watched pull request that has
// none: in the cached lists, then the detail cache, then (at most every BranchWatch per
// pull request) on GitHub. Worker goroutine only (it may make a request).
func (s *Store) resolveWatchedHeads(ctx context.Context) {
	now := s.opts.Now()
	s.mu.Lock()
	var todo []PullRequestRef
	for r, w := range s.prWatches {
		if w.head == "" {
			todo = append(todo, r)
		}
	}
	s.mu.Unlock()
	if len(todo) == 0 {
		return
	}
	slices.SortFunc(todo, func(a, b PullRequestRef) int { return strings.Compare(a.String(), b.String()) })
	known := s.cachedByRef()
	for _, r := range todo {
		head := known[r].HeadRef
		if head == "" {
			if d, ok, err := s.cache.loadDetail(ctx, r.Slug, r.Number); err == nil && ok {
				head = d.PullRequest.HeadRef
			}
		}
		if head == "" {
			s.mu.Lock()
			w, ok := s.prWatches[r]
			s.mu.Unlock()
			if !ok || (!w.tried.IsZero() && now.Sub(w.tried) < s.opts.BranchWatch) {
				continue
			}
			s.setWatch(r, func(w *prWatch) { w.tried = now })
			d, err := s.fetchPullRequest(ctx, r.Slug, r.Number)
			if err != nil {
				s.log.Warn("gh watched pull request lookup failed", "pr", r.String(), "err", err)
				continue
			}
			head = d.PullRequest.HeadRef
		}
		if head != "" {
			s.setWatch(r, func(w *prWatch) { w.head = head })
		}
	}
}

// setWatch updates r's entry when it is still watched.
func (s *Store) setWatch(r PullRequestRef, fn func(*prWatch)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if w, ok := s.prWatches[r]; ok {
		fn(&w)
		s.prWatches[r] = w
	}
}

// cachedByRef indexes the cached lists (dashboards and branches) by pull request, the
// first non-placeholder copy winning.
func (s *Store) cachedByRef() map[PullRequestRef]PullRequest {
	out := map[PullRequestRef]PullRequest{}
	for _, p := range knownPullRequests(s.Snapshot(), &s.branches) {
		r := PullRequestRef{strings.ToLower(p.Repo), p.Number}
		if r.Slug == "" || r.Number <= 0 {
			continue
		}
		if have, ok := out[r]; ok && !have.Partial {
			continue
		}
		out[r] = p
	}
	return out
}

// CachedPullRequest returns a pull request as the poll last saw it (the dashboards
// and watched branches), never asking GitHub; false when no list holds it. A
// placeholder (Partial) has its state, head and checks only.
func (s *Store) CachedPullRequest(slug string, number int) (PullRequest, bool) {
	key, err := NormalizeSlug(slug)
	if err != nil || number <= 0 {
		return PullRequest{}, false
	}
	p, ok := s.cachedByRef()[PullRequestRef{key, number}]
	return p, ok
}

// keepFingerprints keeps a watched branch's pull requests that the store follows: the
// viewer's own from the repository itself (keepViewerFingerprints), and the watched
// pull requests (numbers in keep) whoever wrote them.
func keepFingerprints(fps []prFingerprint, login string, keep []int) []prFingerprint {
	if len(keep) == 0 {
		return keepViewerFingerprints(fps, login)
	}
	own := keepViewerFingerprints(fps, login)
	out := make([]prFingerprint, 0, len(fps))
	for _, f := range fps {
		if slices.Contains(keep, f.Number) || slices.ContainsFunc(own, func(o prFingerprint) bool { return o.ID == f.ID }) {
			out = append(out, f)
		}
	}
	return out
}
