package ghtest

import (
	"context"
	"fmt"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// SetDashboard replaces the dashboard (including its Stats) and publishes
// gh.DashboardUpdated.
func (s *Store) SetDashboard(d gh.Dashboard) {
	s.update(func(n *gh.Snapshot) { n.Dashboard = d })
	if s.bus != nil {
		bus.Publish(s.bus, gh.DashboardUpdated{FetchedAt: d.FetchedAt})
	}
}

// SetProjects replaces the project-wide lists and publishes gh.DashboardUpdated.
func (s *Store) SetProjects(p gh.ProjectPullRequests) {
	s.update(func(n *gh.Snapshot) { n.Projects = p })
	if s.bus != nil {
		bus.Publish(s.bus, gh.DashboardUpdated{FetchedAt: s.Snapshot().Dashboard.FetchedAt})
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

// SetCanonicalSlug records that the repository slug is now named canon on GitHub
// (gh.RepoState.CanonicalSlug; "" for none).
func (s *Store) SetCanonicalSlug(slug, canon string) {
	s.update(func(n *gh.Snapshot) {
		r := n.Repos[slug]
		r.Slug, r.CanonicalSlug = slug, canon
		n.Repos[slug] = r
	})
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

// BranchesPullRequests implements gh.Service.
func (s *Store) BranchesPullRequests(_ context.Context, queries []gh.BranchQuery) ([]gh.BranchPullRequests, error) {
	if len(queries) == 0 {
		return nil, nil
	}
	type pair struct{ slug, head string }
	norm := make([]pair, len(queries))
	seen := make(map[pair]bool, len(queries))
	var unique []pair
	for i, q := range queries {
		key, err := gh.NormalizeSlug(q.Slug)
		if err != nil {
			return nil, err
		}
		head := strings.TrimSpace(q.HeadRef)
		if head == "" {
			return nil, fmt.Errorf("%w: empty head", gh.ErrInvalidArgument)
		}
		p := pair{key, head}
		norm[i] = p
		if !seen[p] {
			seen[p] = true
			unique = append(unique, p)
		}
	}
	s.record("branches %d", len(unique))
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]gh.BranchPullRequests, len(queries))
	for i, p := range norm {
		b, ok := s.branch[p.slug+"@"+p.head]
		if !ok {
			b = gh.BranchPullRequests{Slug: p.slug, HeadRef: p.head}
		}
		out[i] = b
	}
	return out, nil
}

// WatchProjects implements gh.Service.
func (s *Store) WatchProjects() {
	s.record("watch_projects")
}
