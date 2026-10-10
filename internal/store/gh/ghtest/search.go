package ghtest

import (
	"context"
	"fmt"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

var _ gh.Finder = (*Store)(nil)

// AddRepositories adds repositories SearchRepositories and LookupRepository find.
func (s *Store) AddRepositories(rs ...gh.Repository) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cards = append(s.cards, rs...)
}

// SearchRepositories implements gh.Finder: every repository whose slug or description
// contains query, case-insensitively, at most gh.MaxSearchResults. SetError fails it.
func (s *Store) SearchRepositories(_ context.Context, query string) ([]gh.Repository, error) {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return nil, fmt.Errorf("%w: empty search", gh.ErrInvalidArgument)
	}
	s.record("search %s", q)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return nil, s.err
	}
	out := []gh.Repository{}
	for _, r := range s.cards {
		if len(out) < gh.MaxSearchResults && strings.Contains(strings.ToLower(r.Slug()+" "+r.Description), q) {
			out = append(out, r)
		}
	}
	return out, nil
}

// LookupRepository implements gh.Finder (case-insensitive). SetError fails it.
func (s *Store) LookupRepository(_ context.Context, owner, name string) (gh.Repository, error) {
	key, err := gh.NormalizeSlug(owner + "/" + name)
	if err != nil {
		return gh.Repository{}, err
	}
	s.record("lookup %s", key)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return gh.Repository{}, s.err
	}
	for _, r := range s.cards {
		if strings.EqualFold(r.Slug(), key) {
			return r, nil
		}
	}
	return gh.Repository{}, fmt.Errorf("%w: %s", gh.ErrNotFound, key)
}
