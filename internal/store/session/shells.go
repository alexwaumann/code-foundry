package session

import (
	"context"
	"fmt"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// removeShells kills and removes every shell terminal.new started for thread id and
// every action terminal run for it (termlabel.IsPanel). Closing a thread leaves them
// running; removing it takes them along.
func (m *Manager) removeShells(ctx context.Context, id string) error {
	n, err := terminal.KillAndRemoveWhere(ctx, m.opts.Terminals, func(t terminal.Terminal) bool {
		return termlabel.IsPanel(t.Labels) && t.Labels[termlabel.Session] == id
	})
	if err != nil {
		return fmt.Errorf("session %s: remove its shells: %w", id, err)
	}
	if n > 0 {
		m.log.Info("removed the thread's shells", "session", id, "count", n)
	}
	return nil
}
