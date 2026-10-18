package daemon

import (
	"context"
	"log/slog"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// pluginTerminalExits is the plugin store's TerminalExited (plugin.Manager).
type pluginTerminalExits interface {
	TerminalExited(id string, exitCode int)
}

// startPluginTerminalExits tells the plugin store when a plugin terminal's process exits,
// once per terminal, so its plugin gets terminal/exited (docs/notes/plugins-10-host-gaps.md).
func startPluginTerminalExits(ctx context.Context, log *slog.Logger, terms terminal.Store, plugins pluginTerminalExits) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	events, err := terms.Watch(ctx)
	if err != nil {
		log.Warn("plugin terminal exits: watch terminals", "err", err)
		cancel()
		return func() {}
	}
	var wg sync.WaitGroup
	wg.Go(func() {
		told := map[string]bool{}
		for {
			select {
			case <-ctx.Done():
				return
			case ev, ok := <-events:
				if !ok {
					return
				}
				switch t := ev.Updated; {
				case ev.RemovedID != "":
					delete(told, ev.RemovedID)
				case t != nil && t.State == terminal.StateExited && termlabel.IsPlugin(t.Labels) && !told[t.ID]:
					told[t.ID] = true
					plugins.TerminalExited(t.ID, t.ExitCode)
				}
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}
