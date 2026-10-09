// Package ghtest provides an in-memory fake of gh.Service for handler and integration
// tests. Setters publish the same bus events as the real store.
package ghtest

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// Store is a fake gh.Service. The zero value is not usable; use New.
type Store struct {
	bus  *bus.Bus
	snap atomic.Pointer[gh.Snapshot]

	mu      sync.Mutex
	details map[string]gh.PullRequestDetail
	checks  map[string]gh.RefChecks
	branch  map[string]gh.BranchPullRequests
	err     error
	calls   []string
}

var _ gh.Service = (*Store)(nil)

// New returns an empty fake that publishes to b (which may be nil).
func New(b *bus.Bus) *Store {
	s := &Store{bus: b, details: map[string]gh.PullRequestDetail{}, checks: map[string]gh.RefChecks{}, branch: map[string]gh.BranchPullRequests{}}
	s.snap.Store(&gh.Snapshot{Viewer: gh.ViewerState{Authenticated: true}, Repos: map[string]gh.RepoState{}})
	return s
}

// SetViewer replaces the viewer state and publishes gh.ViewerUpdated.
func (s *Store) SetViewer(v gh.ViewerState) {
	s.update(func(n *gh.Snapshot) { n.Viewer = v })
	if s.bus != nil {
		bus.Publish(s.bus, gh.ViewerUpdated{FetchedAt: v.FetchedAt})
	}
}

// SetRepo replaces a repository's state (keyed by r.Slug) and publishes
// gh.RepoActivityUpdated.
func (s *Store) SetRepo(r gh.RepoState) {
	s.update(func(n *gh.Snapshot) { n.Repos[r.Slug] = r })
	if s.bus != nil {
		bus.Publish(s.bus, gh.RepoActivityUpdated{Slug: r.Slug, FetchedAt: r.Activity.DefaultBranch.FetchedAt})
	}
}

// SetPoll replaces the last poll's state and publishes gh.Polled.
func (s *Store) SetPoll(p gh.PollState) {
	s.update(func(n *gh.Snapshot) { n.Poll = p })
	if s.bus != nil {
		bus.Publish(s.bus, gh.Polled(p))
	}
}

// SetPullRequest sets what PullRequest returns for slug and d.PullRequest.Number.
func (s *Store) SetPullRequest(slug string, d gh.PullRequestDetail) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.details[fmt.Sprintf("%s#%d", slug, d.PullRequest.Number)] = d
}

// SetChecks sets what Checks returns for slug and ref.
func (s *Store) SetChecks(slug, ref string, c gh.RefChecks) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.checks[slug+"@"+ref] = c
}

// SetError makes Refresh, PullRequest, and Checks fail with err (nil clears it).
func (s *Store) SetError(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.err = err
}

// Calls returns the mutating calls received, e.g. "track a/b", "refresh a/b".
func (s *Store) Calls() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.calls...)
}

func (s *Store) record(format string, args ...any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, fmt.Sprintf(format, args...))
}

func (s *Store) update(fn func(*gh.Snapshot)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.snap.Load()
	n := &gh.Snapshot{Viewer: old.Viewer, Dashboard: old.Dashboard, Poll: old.Poll, Repos: make(map[string]gh.RepoState, len(old.Repos)+1)}
	for k, v := range old.Repos {
		n.Repos[k] = v
	}
	fn(n)
	s.snap.Store(n)
}

// Snapshot implements gh.Service.
func (s *Store) Snapshot() *gh.Snapshot { return s.snap.Load() }

// Track implements gh.Service.
func (s *Store) Track(slug string) error {
	key, err := gh.NormalizeSlug(slug)
	if err != nil {
		return err
	}
	s.record("track %s", key)
	r := s.Snapshot().Repos[key]
	r.Slug, r.Tracked = key, true
	s.SetRepo(r)
	return nil
}

// Untrack implements gh.Service.
func (s *Store) Untrack(slug string) error {
	key, err := gh.NormalizeSlug(slug)
	if err != nil {
		return err
	}
	s.record("untrack %s", key)
	if r, ok := s.Snapshot().Repos[key]; ok {
		r.Tracked = false
		s.SetRepo(r)
	}
	return nil
}

// Refresh implements gh.Service.
func (s *Store) Refresh(_ context.Context, slug string) error {
	if slug != "" {
		key, err := gh.NormalizeSlug(slug)
		if err != nil {
			return err
		}
		slug = key
	}
	s.record("refresh %s", slug)
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

// PullRequest implements gh.Service.
func (s *Store) PullRequest(_ context.Context, slug string, number int) (gh.PullRequestDetail, error) {
	key, err := gh.NormalizeSlug(slug)
	if err != nil {
		return gh.PullRequestDetail{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return gh.PullRequestDetail{}, s.err
	}
	d, ok := s.details[fmt.Sprintf("%s#%d", key, number)]
	if !ok {
		return gh.PullRequestDetail{}, fmt.Errorf("%w: %s#%d", gh.ErrNotFound, key, number)
	}
	return d, nil
}

// Checks implements gh.Service.
func (s *Store) Checks(_ context.Context, slug, ref string) (gh.RefChecks, error) {
	key, err := gh.NormalizeSlug(slug)
	if err != nil {
		return gh.RefChecks{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return gh.RefChecks{}, s.err
	}
	c, ok := s.checks[key+"@"+ref]
	if !ok {
		return gh.RefChecks{}, fmt.Errorf("%w: %s@%s", gh.ErrNotFound, key, ref)
	}
	return c, nil
}
