package ghtest

import (
	"context"
	"fmt"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// SetPullRequestCheckbox implements gh.Service: it records "checkbox <key> <index>
// <checked> <text>". A pull request that is not set fails NotFound; an item that is gone
// or reads differently fails like the real store and, like it, publishes
// gh.PullRequestDetailUpdated so the client reads again. A change edits the detail's Body
// and publishes gh.PullRequestDetailUpdated.
func (s *Store) SetPullRequestCheckbox(_ context.Context, slug string, number int, r gh.CheckboxChange) (gh.CheckboxResult, error) {
	key, err := prKey(slug, number)
	if err != nil {
		return gh.CheckboxResult{}, err
	}
	s.record("checkbox %s %d %t %s", key, r.Index, r.Checked, r.Text)
	s.mu.Lock()
	if s.err != nil {
		defer s.mu.Unlock()
		return gh.CheckboxResult{}, s.err
	}
	d, ok := s.detail.full[key]
	if !ok {
		s.mu.Unlock()
		return gh.CheckboxResult{}, fmt.Errorf("%w: %s", gh.ErrNotFound, key)
	}
	next, changed, why := gh.SetTaskItem(d.Body, r.Index, r.Text, r.Checked)
	if why != "" {
		s.mu.Unlock()
		s.publishDetail(strings.Split(key, "#")[0], number)
		return gh.CheckboxResult{}, fmt.Errorf("%w: pull request #%d %s", gh.ErrFailedPrecondition, number, why)
	}
	d.Body = next
	s.detail.full[key] = d
	s.mu.Unlock()
	s.publishDetail(strings.Split(key, "#")[0], number)
	return gh.CheckboxResult{Changed: changed, Message: fmt.Sprintf("Changed task %d on #%d", r.Index+1, number)}, nil
}
