package daemon

import (
	"context"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// pluginContexts is the plugin store's ContextsChanged (plugin.Manager): it rechecks
// its open surface instances.
type pluginContexts interface{ ContextsChanged() }

// startPluginContexts tells the plugin store when a thread or project changed, so an
// open surface whose thread was archived or removed, or whose project was removed, or
// whose when clause stopped holding closes at once (docs/notes/plugins-10-host-gaps.md).
// The store batches the calls.
func startPluginContexts(ctx context.Context, b *bus.Bus, plugins pluginContexts) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	threads := bus.Subscribe[thread.Event](b, 256)
	projects := bus.Subscribe[project.Event](b, 256)
	var wg sync.WaitGroup
	wg.Go(func() {
		defer threads.Close()
		defer projects.Close()
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-threads.C():
				switch ev.(type) {
				case thread.Updated, thread.Removed:
					plugins.ContextsChanged()
				}
			case ev := <-projects.C():
				switch ev.(type) {
				case project.ProjectUpdated, project.ProjectRemoved, project.WorktreeRemoved:
					plugins.ContextsChanged()
				}
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}
