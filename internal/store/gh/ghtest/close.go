package ghtest

import (
	"context"
	"fmt"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// SetPullRequestClosed implements gh.Service: it records "close <key>" or "reopen
// <key>". A pull request that is not set fails NotFound; closing one that is not open,
// or reopening one that is not closed (merged included), fails like the real store, and
// so does a detail without ViewerCanClose / ViewerCanReopen (PermissionDenied). A
// success sets State (and ViewerCanReopen to whether it is now closed) and publishes
// gh.PullRequestDetailUpdated.
func (s *Store) SetPullRequestClosed(_ context.Context, slug string, number int, closed bool) (gh.ClosedResult, error) {
	key, err := prKey(slug, number)
	if err != nil {
		return gh.ClosedResult{}, err
	}
	verb, from, to, msg := "reopen", gh.PullRequestClosed, gh.PullRequestOpen, "Reopened"
	if closed {
		verb, from, to, msg = "close", gh.PullRequestOpen, gh.PullRequestClosed, "Closed"
	}
	s.record("%s %s", verb, key)
	s.mu.Lock()
	if s.err != nil {
		defer s.mu.Unlock()
		return gh.ClosedResult{}, s.err
	}
	d, ok := s.detail.full[key]
	may := d.ViewerCanReopen
	if closed {
		may = d.ViewerCanClose
	}
	switch {
	case !ok:
		s.mu.Unlock()
		return gh.ClosedResult{}, fmt.Errorf("%w: %s", gh.ErrNotFound, key)
	case d.PullRequest.State != from:
		s.mu.Unlock()
		return gh.ClosedResult{}, fmt.Errorf("%w: pull request #%d is %s, not %s", gh.ErrFailedPrecondition, number,
			strings.ToLower(string(d.PullRequest.State)), strings.ToLower(string(from)))
	case !may:
		s.mu.Unlock()
		return gh.ClosedResult{}, fmt.Errorf("%w: GitHub does not let you %s pull request #%d", gh.ErrPermissionDenied, verb, number)
	}
	d.PullRequest.State = to
	d.ViewerCanReopen = closed
	s.detail.full[key] = d
	s.mu.Unlock()
	s.publishDetail(strings.Split(key, "#")[0], number)
	return gh.ClosedResult{State: to, Message: fmt.Sprintf("%s #%d", msg, number)}, nil
}
