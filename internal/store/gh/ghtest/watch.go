package ghtest

import (
	"cmp"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// WatchPullRequests records "watch <ref> <ref>…" (sorted; "watch" alone for none) and
// keeps the set for Watched.
func (s *Store) WatchPullRequests(refs []gh.PullRequestRef) error {
	var names []string
	for _, r := range refs {
		slug, err := gh.NormalizeSlug(r.Slug)
		if err != nil {
			return err
		}
		names = append(names, gh.PullRequestRef{Slug: slug, Number: r.Number}.String())
	}
	slices.Sort(names)
	s.record("%s", strings.TrimSpace("watch "+strings.Join(names, " ")))
	s.mu.Lock()
	s.watched = names
	s.mu.Unlock()
	return nil
}

// Watched is the last set WatchPullRequests got, as "owner/name#N", sorted.
func (s *Store) Watched() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.watched)
}

// CachedPullRequest finds a pull request in the dashboard lists, the branches set with
// SetBranchPullRequests, then the details set with SetPullRequest.
func (s *Store) CachedPullRequest(slug string, number int) (gh.PullRequest, bool) {
	key, err := gh.NormalizeSlug(slug)
	if err != nil {
		return gh.PullRequest{}, false
	}
	match := func(p gh.PullRequest) bool { return strings.EqualFold(p.Repo, key) && p.Number == number }
	d := s.Snapshot().Dashboard
	for _, list := range [][]gh.PullRequest{d.Authored, d.ReviewRequested, d.Reviewed, d.RecentlyMerged} {
		if i := slices.IndexFunc(list, match); i >= 0 {
			return list[i], true
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, b := range s.branch {
		for _, p := range b.PullRequests {
			p.Repo = cmp.Or(p.Repo, b.Slug)
			if match(p) {
				return p, true
			}
		}
	}
	if det, ok := s.details[gh.PullRequestRef{Slug: key, Number: number}.String()]; ok {
		return det.PullRequest, true
	}
	return gh.PullRequest{}, false
}
