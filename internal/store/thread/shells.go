package thread

import (
	"context"
	"fmt"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// ShellsGo says why a thread's shells are going (Options.ShellsGoing).
type ShellsGo int

// Why a thread's shells go.
const (
	ShellsArchived ShellsGo = iota + 1
	ShellsSnoozed           // snoozed, or saved for later
	ShellsRemoved           // removed, or its failed setup discarded
)

func (w ShellsGo) String() string {
	switch w {
	case ShellsArchived:
		return "archived"
	case ShellsSnoozed:
		return "snoozed"
	case ShellsRemoved:
		return "removed"
	}
	return "unknown"
}

// removeShells kills and removes every shell terminal.new started for thread id and
// every action terminal run for it (termlabel.IsPanel). Closing a thread leaves them
// running; removing it takes them along. Options.ShellsGoing hears of it first, why
// saying what is happening to the thread.
func (m *Manager) removeShells(ctx context.Context, id string, why ShellsGo) error {
	if m.opts.ShellsGoing != nil {
		m.opts.ShellsGoing(ctx, id, why)
	}
	n, err := terminal.KillAndRemoveWhere(ctx, m.opts.Terminals, func(t terminal.Terminal) bool {
		return termlabel.IsPanel(t.Labels) && t.Labels[termlabel.Thread] == id
	})
	if err != nil {
		return fmt.Errorf("thread %s: remove its shells: %w", id, err)
	}
	if n > 0 {
		m.log.Info("removed the thread's shells", "thread", id, "count", n)
	}
	return nil
}
