package threadtest

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// AddProject records "AddProject <id> <ref>" and adds ref (taken as a project id; the
// fake has no project store) with its checkout at /worktrees/<ref>, leaving the
// workspace, with the store's refusals.
func (f *Fake) AddProject(_ context.Context, id, ref string) (thread.Thread, error) {
	ref = strings.TrimSpace(ref)
	return f.mutate(fmt.Sprintf("AddProject %s %s", id, ref), id, func(s *thread.Thread) error {
		if err := thread.CheckMembersChange(*s); err != nil {
			return err
		}
		if slices.Contains(s.Projects(), ref) {
			return fmt.Errorf("%w: project %s is already one of thread %s's projects", thread.ErrFailedPrecondition, ref, id)
		}
		*s = thread.WithMember(*s, ref, "/worktrees/"+ref)
		return nil
	})
}

// RemoveProject records "RemoveProject <id> <ref>" and drops member ref, leaving the
// workspace, with the store's refusals.
func (f *Fake) RemoveProject(_ context.Context, id, ref string) (thread.Thread, error) {
	ref = strings.TrimSpace(ref)
	return f.mutate(fmt.Sprintf("RemoveProject %s %s", id, ref), id, func(s *thread.Thread) error {
		if err := thread.CheckMembersChange(*s); err != nil {
			return err
		}
		if !slices.Contains(s.Projects(), ref) {
			return fmt.Errorf("%w: %q is not one of thread %s's projects", thread.ErrFailedPrecondition, ref, id)
		}
		next, err := thread.WithoutMember(*s, ref, ref)
		if err != nil {
			return err
		}
		*s = next
		return nil
	})
}
