package ghtest

import (
	"context"
	"slices"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

var _ gh.Owners = (*Store)(nil)

// SetPublishOwners sets what PublishOwners returns.
func (s *Store) SetPublishOwners(owners ...gh.PublishOwner) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.owners = slices.Clone(owners)
}

// PublishOwners implements gh.Owners. SetError fails it.
func (s *Store) PublishOwners(context.Context) ([]gh.PublishOwner, error) {
	s.record("publish owners")
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return nil, s.err
	}
	out := make([]gh.PublishOwner, len(s.owners))
	for i, o := range s.owners {
		o.Allowed = slices.Clone(o.Allowed)
		out[i] = o
	}
	return out, nil
}
