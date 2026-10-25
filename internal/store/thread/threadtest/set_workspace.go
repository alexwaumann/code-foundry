package threadtest

import (
	"context"
	"fmt"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// SetWorkspace records "SetWorkspace <id> <ref>" and sets the thread's workspace
// reference to ref as given (the fake has no workspace store to resolve names), with
// the store's refusal for a thread that runs in its workspace's folder.
func (f *Fake) SetWorkspace(_ context.Context, id, ref string) (thread.Thread, error) {
	ref = strings.TrimSpace(ref)
	return f.mutate(fmt.Sprintf("SetWorkspace %s %s", id, ref), id, func(s *thread.Thread) error {
		if err := thread.CheckWorkspaceChange(*s, ref); err != nil {
			return err
		}
		s.WorkspaceID = ref
		return nil
	})
}
