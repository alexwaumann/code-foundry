package ghtest

import (
	"context"
	"fmt"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// detailState backs the pull request detail panel methods. Keys are "slug#number".
type detailState struct {
	full       map[string]gh.FullPullRequest
	candidates map[string]gh.ReviewerCandidates
	reverts    map[string]gh.RevertResult
}

func prKey(slug string, number int) (string, error) {
	key, err := gh.NormalizeSlug(slug)
	if err != nil {
		return "", err
	}
	if number <= 0 {
		return "", fmt.Errorf("%w: pull request number %d", gh.ErrInvalidArgument, number)
	}
	return fmt.Sprintf("%s#%d", key, number), nil
}

// SetFullPullRequest sets what FullPullRequest returns for slug and
// d.PullRequest.Number, and publishes gh.PullRequestDetailUpdated.
func (s *Store) SetFullPullRequest(slug string, d gh.FullPullRequest) {
	key, _ := gh.NormalizeSlug(slug)
	s.mu.Lock()
	if s.detail.full == nil {
		s.detail.full = map[string]gh.FullPullRequest{}
	}
	s.detail.full[fmt.Sprintf("%s#%d", key, d.PullRequest.Number)] = d
	s.mu.Unlock()
	s.publishDetail(key, d.PullRequest.Number)
}

// SetReviewerCandidates sets what ReviewerCandidates returns for slug and number.
// SetReviewRequest flips Requested on a listed candidate.
func (s *Store) SetReviewerCandidates(slug string, number int, c gh.ReviewerCandidates) {
	key, _ := prKey(slug, number)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.detail.candidates == nil {
		s.detail.candidates = map[string]gh.ReviewerCandidates{}
	}
	s.detail.candidates[key] = c
}

// SetRevert sets what RevertPullRequest returns for slug and number (the pull request
// must also be set, merged, with SetFullPullRequest).
func (s *Store) SetRevert(slug string, number int, r gh.RevertResult) {
	key, _ := prKey(slug, number)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.detail.reverts == nil {
		s.detail.reverts = map[string]gh.RevertResult{}
	}
	s.detail.reverts[key] = r
}

func (s *Store) publishDetail(slug string, number int) {
	if s.bus != nil {
		bus.Publish(s.bus, gh.PullRequestDetailUpdated{Slug: slug, Number: number})
	}
}

// FullPullRequest implements gh.Service. refresh is recorded as "refresh-detail <key>".
func (s *Store) FullPullRequest(_ context.Context, slug string, number int, refresh bool) (gh.FullPullRequest, error) {
	key, err := prKey(slug, number)
	if err != nil {
		return gh.FullPullRequest{}, err
	}
	if refresh {
		s.record("refresh-detail %s", key)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return gh.FullPullRequest{}, s.err
	}
	d, ok := s.detail.full[key]
	if !ok {
		return gh.FullPullRequest{}, fmt.Errorf("%w: %s", gh.ErrNotFound, key)
	}
	return d, nil
}

// ReviewerCandidates implements gh.Service.
func (s *Store) ReviewerCandidates(_ context.Context, slug string, number int) (gh.ReviewerCandidates, error) {
	key, err := prKey(slug, number)
	if err != nil {
		return gh.ReviewerCandidates{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return gh.ReviewerCandidates{}, s.err
	}
	c, ok := s.detail.candidates[key]
	if !ok {
		return gh.ReviewerCandidates{}, fmt.Errorf("%w: %s", gh.ErrNotFound, key)
	}
	c.Candidates = append([]gh.ReviewerCandidate(nil), c.Candidates...)
	return c, nil
}

// SetReviewRequest implements gh.Service: it records "review <key> <kind> <login>
// <requested>", flips the candidate, publishes gh.PullRequestDetailUpdated, and returns
// the requested candidates' logins.
func (s *Store) SetReviewRequest(_ context.Context, slug string, number int, r gh.ReviewRequest) ([]string, error) {
	key, err := prKey(slug, number)
	if err != nil {
		return nil, err
	}
	kind := r.Kind
	if kind == "" {
		kind = gh.ReviewerUser
	}
	if kind != gh.ReviewerUser && kind != gh.ReviewerTeam || strings.TrimSpace(r.Login) == "" {
		return nil, fmt.Errorf("%w: reviewer %s %q", gh.ErrInvalidArgument, r.Kind, r.Login)
	}
	s.record("review %s %s %s %t", key, kind, r.Login, r.Requested)
	s.mu.Lock()
	if s.err != nil {
		err := s.err
		s.mu.Unlock()
		return nil, err
	}
	c := s.detail.candidates[key]
	requested := []string{}
	for i := range c.Candidates {
		if strings.EqualFold(c.Candidates[i].Login, r.Login) && c.Candidates[i].Kind == kind {
			c.Candidates[i].Requested = r.Requested
		}
		if c.Candidates[i].Requested {
			requested = append(requested, c.Candidates[i].Login)
		}
	}
	s.mu.Unlock()
	norm, _ := gh.NormalizeSlug(slug)
	s.publishDetail(norm, number)
	return requested, nil
}

// RevertPullRequest implements gh.Service: it records "revert <key>". A pull request
// that is not set, or not merged, fails like the real store.
func (s *Store) RevertPullRequest(_ context.Context, slug string, number int) (gh.RevertResult, error) {
	key, err := prKey(slug, number)
	if err != nil {
		return gh.RevertResult{}, err
	}
	s.record("revert %s", key)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return gh.RevertResult{}, s.err
	}
	d, ok := s.detail.full[key]
	switch {
	case !ok:
		return gh.RevertResult{}, fmt.Errorf("%w: %s", gh.ErrNotFound, key)
	case d.PullRequest.State != gh.PullRequestMerged:
		return gh.RevertResult{}, fmt.Errorf("%w: pull request #%d is not merged", gh.ErrFailedPrecondition, number)
	}
	if r, ok := s.detail.reverts[key]; ok {
		return r, nil
	}
	return gh.RevertResult{Number: 9000 + number, URL: fmt.Sprintf("https://github.com/%s/pull/%d", strings.Split(key, "#")[0], 9000+number)}, nil
}
