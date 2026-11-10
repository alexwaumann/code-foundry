package threadtest

import (
	"context"
	"fmt"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// regeneratedName is the name the fake's RegenerateName gives a thread.
const regeneratedName = "Regenerated name"

// RegenerateName records "RegenerateName <id>" and names the thread regeneratedName as
// the utility model would (AutoNamed, not provisional). A resident thread is refused.
func (f *Fake) RegenerateName(_ context.Context, id string) (thread.Thread, error) {
	return f.mutate("RegenerateName "+id, id, func(s *thread.Thread) error {
		if s.Kind == thread.KindResident {
			return fmt.Errorf("%w: thread %s is a resident thread; it cannot be renamed", thread.ErrFailedPrecondition, id)
		}
		s.Name, s.AutoNamed, s.NameProvisional, s.Naming = regeneratedName, true, false, false
		return nil
	})
}
