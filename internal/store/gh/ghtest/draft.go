package ghtest

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// SetPullRequestDraft implements gh.Service: it records "draft <key> <bool>". A pull
// request that is not set fails NotFound; one that is not open or already in that state
// fails like the real store. A success flips Draft and publishes
// gh.PullRequestDetailUpdated.
func (s *Store) SetPullRequestDraft(_ context.Context, slug string, number int, draft bool) (gh.DraftResult, error) {
	key, err := prKey(slug, number)
	if err != nil {
		return gh.DraftResult{}, err
	}
	s.record("draft %s %t", key, draft)
	s.mu.Lock()
	if s.err != nil {
		defer s.mu.Unlock()
		return gh.DraftResult{}, s.err
	}
	d, ok := s.detail.full[key]
	switch {
	case !ok:
		s.mu.Unlock()
		return gh.DraftResult{}, fmt.Errorf("%w: %s", gh.ErrNotFound, key)
	case d.PullRequest.State != gh.PullRequestOpen:
		s.mu.Unlock()
		return gh.DraftResult{}, fmt.Errorf("%w: pull request #%d is not open", gh.ErrFailedPrecondition, number)
	case d.PullRequest.Draft == draft:
		s.mu.Unlock()
		return gh.DraftResult{}, fmt.Errorf("%w: pull request #%d is already so", gh.ErrFailedPrecondition, number)
	}
	d.PullRequest.Draft = draft
	s.detail.full[key] = d
	s.mu.Unlock()
	s.publishDetail(strings.Split(key, "#")[0], number)
	msg := fmt.Sprintf("Marked #%d ready for review", number)
	if draft {
		msg = fmt.Sprintf("Converted #%d to a draft", number)
	}
	return gh.DraftResult{Draft: draft, Message: msg}, nil
}

// SetPullRequestAutoMerge implements gh.Service: it records "auto-merge <key> on
// <method>" (plus " head=<sha>") or "auto-merge <key> off". A pull request that is not
// set, not open, already so, a draft, without AutoMergeAllowed, whose MergeMethods
// (when set) lack the method, or whose head is not the expected one fails like the
// real store. A success sets AutoMerge and AutoMergeMethod and publishes
// gh.PullRequestDetailUpdated.
func (s *Store) SetPullRequestAutoMerge(_ context.Context, slug string, number int, r gh.AutoMergeChange) (gh.AutoMergeResult, error) {
	key, err := prKey(slug, number)
	if err != nil {
		return gh.AutoMergeResult{}, err
	}
	if !r.Enabled {
		s.record("auto-merge %s off", key)
	} else {
		switch r.Method {
		case gh.MergeCommit, gh.MergeSquash, gh.MergeRebase:
		default:
			return gh.AutoMergeResult{}, fmt.Errorf("%w: merge method %q", gh.ErrInvalidArgument, r.Method)
		}
		if r.ExpectedHeadSHA != "" {
			s.record("auto-merge %s on %s head=%s", key, r.Method, r.ExpectedHeadSHA)
		} else {
			s.record("auto-merge %s on %s", key, r.Method)
		}
	}
	s.mu.Lock()
	if s.err != nil {
		defer s.mu.Unlock()
		return gh.AutoMergeResult{}, s.err
	}
	d, ok := s.detail.full[key]
	refuse := func(why string) (gh.AutoMergeResult, error) {
		s.mu.Unlock()
		return gh.AutoMergeResult{}, fmt.Errorf("%w: pull request #%d %s", gh.ErrFailedPrecondition, number, why)
	}
	switch {
	case !ok:
		s.mu.Unlock()
		return gh.AutoMergeResult{}, fmt.Errorf("%w: %s", gh.ErrNotFound, key)
	case d.PullRequest.State != gh.PullRequestOpen:
		return refuse("is not open")
	case d.AutoMerge == r.Enabled:
		return refuse("already has auto-merge " + map[bool]string{true: "on", false: "off"}[r.Enabled])
	case !r.Enabled:
	case d.PullRequest.Draft:
		return refuse("is a draft")
	case !d.AutoMergeAllowed:
		return refuse("cannot use auto-merge: the repository does not allow it")
	case len(d.MergeMethods) > 0 && !slices.Contains(d.MergeMethods, r.Method):
		return refuse("cannot be merged with " + string(r.Method))
	case r.ExpectedHeadSHA != "" && r.ExpectedHeadSHA != d.PullRequest.HeadSHA:
		return refuse("changed since it was shown; refresh and try again")
	}
	d.AutoMerge, d.AutoMergeMethod = r.Enabled, r.Method
	s.detail.full[key] = d
	s.mu.Unlock()
	s.publishDetail(strings.Split(key, "#")[0], number)
	msg := fmt.Sprintf("Auto-merge off for #%d", number)
	if r.Enabled {
		msg = fmt.Sprintf("Auto-merge on for #%d with %s", number, r.Method)
	}
	return gh.AutoMergeResult{Enabled: r.Enabled, Method: r.Method, Message: msg}, nil
}
