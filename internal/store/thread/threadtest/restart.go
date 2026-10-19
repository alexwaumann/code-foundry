package threadtest

import (
	"context"
	"fmt"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Restart records "Restart <id>". A connected or starting thread restarts (restarted
// true) and loses PluginEnvStale; any other is left as it is, like the store.
func (f *Fake) Restart(_ context.Context, id string) (thread.Thread, bool, error) {
	restarted := false
	s, err := f.mutate(fmt.Sprintf("Restart %s", id), id, func(s *thread.Thread) error {
		if s.State == thread.StateConnected || s.State == thread.StateStarting {
			restarted = true
			s.PluginEnvStale, s.PluginEnvChange = false, ""
		}
		return nil
	})
	return s, restarted, err
}
