package ghtest

import (
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// ChangePullRequest publishes e as a poll would after seeing the change (the fake
// keeps no pull request lists; set what reads return with SetDashboard,
// SetBranchPullRequests or SetPullRequest).
func (s *Store) ChangePullRequest(e gh.PullRequestChanged) {
	if s.bus != nil {
		bus.Publish(s.bus, e)
	}
}
