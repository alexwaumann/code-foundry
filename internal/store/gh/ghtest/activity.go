package ghtest

import (
	"context"
	"fmt"
	"strings"

	"github.com/awaumann/code-foundry/internal/bus"
	"github.com/awaumann/code-foundry/internal/store/gh"
)

// SetDashboard replaces the dashboard (including its Stats) and publishes
// gh.DashboardUpdated.
func (s *Store) SetDashboard(d gh.Dashboard) {
	s.update(func(n *gh.Snapshot) { n.Dashboard = d })
	if s.bus != nil {
		bus.Publish(s.bus, gh.DashboardUpdated{FetchedAt: d.FetchedAt})
	}
}

// SetActivity replaces a repository's activity (keyed by slug) and publishes
// gh.RepoActivityUpdated.
func (s *Store) SetActivity(slug string, a gh.RepoActivity) {
	s.update(func(n *gh.Snapshot) {
		r := n.Repos[slug]
		r.Slug, r.Activity = slug, a
		n.Repos[slug] = r
	})
	if s.bus != nil {
		bus.Publish(s.bus, gh.RepoActivityUpdated{Slug: slug, FetchedAt: a.Stats.FetchedAt})
	}
}

// SetBranchPullRequests sets what BranchPullRequests returns for b.Slug and b.HeadRef
// and publishes gh.BranchPullRequestsUpdated.
func (s *Store) SetBranchPullRequests(b gh.BranchPullRequests) {
	s.mu.Lock()
	s.branch[b.Slug+"@"+b.HeadRef] = b
	s.mu.Unlock()
	if s.bus != nil {
		bus.Publish(s.bus, gh.BranchPullRequestsUpdated{Slug: b.Slug, HeadRef: b.HeadRef, FetchedAt: b.FetchedAt})
	}
}

// BranchPullRequests implements gh.Service. Unknown branches return an empty,
// never-fetched result, like the real store before its first poll.
func (s *Store) BranchPullRequests(_ context.Context, slug, head string) (gh.BranchPullRequests, error) {
	key, err := gh.NormalizeSlug(slug)
	if err != nil {
		return gh.BranchPullRequests{}, err
	}
	head = strings.TrimSpace(head)
	if head == "" {
		return gh.BranchPullRequests{}, fmt.Errorf("%w: empty head", gh.ErrInvalidArgument)
	}
	s.record("branch %s %s", key, head)
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.branch[key+"@"+head]
	if !ok {
		b = gh.BranchPullRequests{Slug: key, HeadRef: head}
	}
	return b, nil
}
