package ghtest

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// MergePullRequest implements gh.Service: it records "merge <key> <method>
// delete=<bool>" (plus " head=<sha>" with an expected head). A pull request that is not
// set, not open, a draft, whose MergeMethods (when set) lack the method, or whose head
// is not the expected one fails like the real store. A success marks the pull request
// merged (sha "merge-<number>"), publishes gh.PullRequestDetailUpdated, and deletes the
// head branch when asked (not a fork's, the default branch, or the base branch).
func (s *Store) MergePullRequest(_ context.Context, slug string, number int, r gh.MergeRequest) (gh.MergeResult, error) {
	key, err := prKey(slug, number)
	if err != nil {
		return gh.MergeResult{}, err
	}
	switch r.Method {
	case gh.MergeCommit, gh.MergeSquash, gh.MergeRebase:
	default:
		return gh.MergeResult{}, fmt.Errorf("%w: merge method %q", gh.ErrInvalidArgument, r.Method)
	}
	if r.ExpectedHeadSHA != "" {
		s.record("merge %s %s delete=%t head=%s", key, r.Method, r.DeleteBranch, r.ExpectedHeadSHA)
	} else {
		s.record("merge %s %s delete=%t", key, r.Method, r.DeleteBranch)
	}
	s.mu.Lock()
	if s.err != nil {
		defer s.mu.Unlock()
		return gh.MergeResult{}, s.err
	}
	d, ok := s.detail.full[key]
	switch {
	case !ok:
		s.mu.Unlock()
		return gh.MergeResult{}, fmt.Errorf("%w: %s", gh.ErrNotFound, key)
	case d.PullRequest.State != gh.PullRequestOpen:
		s.mu.Unlock()
		return gh.MergeResult{}, fmt.Errorf("%w: pull request #%d is not open", gh.ErrFailedPrecondition, number)
	case d.PullRequest.Draft:
		s.mu.Unlock()
		return gh.MergeResult{}, fmt.Errorf("%w: pull request #%d is a draft", gh.ErrFailedPrecondition, number)
	case len(d.MergeMethods) > 0 && !slices.Contains(d.MergeMethods, r.Method):
		s.mu.Unlock()
		return gh.MergeResult{}, fmt.Errorf("%w: pull request #%d: method %s not allowed", gh.ErrFailedPrecondition, number, r.Method)
	case r.ExpectedHeadSHA != "" && r.ExpectedHeadSHA != d.PullRequest.HeadSHA:
		s.mu.Unlock()
		return gh.MergeResult{}, fmt.Errorf("%w: pull request #%d changed since it was shown; refresh and try again", gh.ErrFailedPrecondition, number)
	}
	res := gh.MergeResult{Merged: true, SHA: fmt.Sprintf("merge-%d", number)}
	res.Message = fmt.Sprintf("Merged #%d (%s)", number, res.SHA[:7])
	head := d.PullRequest.HeadRef
	switch {
	case !r.DeleteBranch:
	case d.PullRequest.IsCrossRepository:
		res.Message += fmt.Sprintf("; kept %s: it is in a fork", head)
	case head == d.DefaultBranch || head == d.PullRequest.BaseRef:
		res.Message += fmt.Sprintf("; kept origin/%s: it is the default or base branch", head)
	default:
		res.BranchDeleted = true
		res.Message += "; deleted origin/" + head
	}
	d.PullRequest.State = gh.PullRequestMerged
	d.MergeCommitSHA = res.SHA
	s.detail.full[key] = d
	s.mu.Unlock()
	s.publishDetail(strings.Split(key, "#")[0], number)
	return res, nil
}
