package threadtest

import (
	"context"
	"fmt"
	"slices"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// StopShell records "StopShell <id> <task>" and drops the shell from the thread's list
// (the store's stopped shell ends once Claude reports it); ErrNotFound when the thread
// runs no such shell.
func (f *Fake) StopShell(_ context.Context, id, taskID string) (thread.Thread, error) {
	return f.mutate(fmt.Sprintf("StopShell %s %s", id, taskID), id, func(s *thread.Thread) error {
		i := slices.IndexFunc(s.BackgroundShells, func(sh thread.BackgroundShell) bool { return sh.TaskID == taskID })
		if i < 0 {
			return fmt.Errorf("%w: thread %s runs no background shell %q", thread.ErrNotFound, id, taskID)
		}
		s.BackgroundShells = slices.Delete(slices.Clone(s.BackgroundShells), i, i+1)
		s.BackgroundShellsRunning = len(s.BackgroundShells)
		return nil
	})
}
