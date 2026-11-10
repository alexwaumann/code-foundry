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
	return cloneOwners(s.owners), nil
}

func cloneOwners(in []gh.PublishOwner) []gh.PublishOwner {
	out := make([]gh.PublishOwner, len(in))
	for i, o := range in {
		o.Allowed = slices.Clone(o.Allowed)
		out[i] = o
	}
	return out
}

// CachedPublishOwners implements gh.Owners: the set owners, never stale, or nothing
// when none were set. Like the real store's cache it is not a call and SetError does not
// fail it.
func (s *Store) CachedPublishOwners(context.Context) ([]gh.PublishOwner, bool, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.owners) == 0 {
		return nil, false, false
	}
	return cloneOwners(s.owners), false, true
}
