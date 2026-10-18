package ghtest

import (
	"context"
	"fmt"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// SetPullRequestDiff sets what PullRequestDiff returns for a pull request.
func (s *Store) SetPullRequestDiff(slug string, number int, d gh.PullRequestDiff) {
	key, _ := prKey(slug, number)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.diffs == nil {
		s.diffs = map[string]gh.PullRequestDiff{}
	}
	s.diffs[key] = d
}

// PullRequestDiff implements gh.Service: it records "diff <key> refresh=<bool>" and
// returns the SetPullRequestDiff value, or NotFound.
func (s *Store) PullRequestDiff(_ context.Context, slug string, number int, refresh bool) (gh.PullRequestDiff, error) {
	key, err := prKey(slug, number)
	if err != nil {
		return gh.PullRequestDiff{}, err
	}
	s.record("diff %s refresh=%t", key, refresh)
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.diffs[key]
	if !ok {
		return gh.PullRequestDiff{}, fmt.Errorf("%w: pull request %s", gh.ErrNotFound, key)
	}
	return d, nil
}

// SetPullRequestFile sets what PullRequestFile returns for (slug, ref, path).
func (s *Store) SetPullRequestFile(slug, ref, path string, f gh.PullRequestFile) {
	key, _ := gh.NormalizeSlug(slug)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.files == nil {
		s.files = map[string]gh.PullRequestFile{}
	}
	s.files[key+"@"+ref+":"+path] = f
}

// PullRequestFile implements gh.Service: it records "file <slug>@<ref>:<path>" and
// returns the SetPullRequestFile value, or NotFound set.
func (s *Store) PullRequestFile(_ context.Context, slug, ref, path string) (gh.PullRequestFile, error) {
	key, err := gh.NormalizeSlug(slug)
	if err != nil {
		return gh.PullRequestFile{}, err
	}
	id := key + "@" + ref + ":" + path
	s.record("file %s", id)
	s.mu.Lock()
	defer s.mu.Unlock()
	if f, ok := s.files[id]; ok {
		return f, nil
	}
	return gh.PullRequestFile{NotFound: true}, nil
}
