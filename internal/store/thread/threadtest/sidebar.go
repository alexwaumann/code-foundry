package threadtest

import (
	"context"
	"fmt"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// SetSidebar records "SetSidebar <id> <shown>" and sets the thread's sidebar override
// like the store: ErrInvalidArgument for a thread no thread created.
func (f *Fake) SetSidebar(_ context.Context, id string, shown bool) (thread.Thread, error) {
	return f.mutate(fmt.Sprintf("SetSidebar %s %t", id, shown), id, func(s *thread.Thread) error {
		if s.CreatedBy == "" {
			return fmt.Errorf("%w: only a thread another thread created can be shown or hidden in the sidebar", thread.ErrInvalidArgument)
		}
		s.SidebarOverride = &shown
		return nil
	})
}

// createSidebar sets Create's InSidebar on s like the store (only with a creator) and
// adds " sidebar=<bool>" to the call.
func createSidebar(s *thread.Thread, o thread.CreateOptions, call *string) error {
	if o.InSidebar == nil {
		return nil
	}
	if s.CreatedBy == "" {
		return fmt.Errorf("%w: only a thread another thread created can be shown or hidden in the sidebar", thread.ErrInvalidArgument)
	}
	v := *o.InSidebar
	s.SidebarOverride = &v
	*call += fmt.Sprintf(" sidebar=%t", v)
	return nil
}
