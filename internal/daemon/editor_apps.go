package daemon

import (
	"context"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

// editorAppsRefresher is the part of the gitops store the settings glue drives.
// *gitops.Manager implements it.
type editorAppsRefresher interface{ RefreshEditorApps() }

// startEditorAppsRefresh makes the gitops store detect the installed editor apps again
// after any settings change (the "Open in" list is cached from its first use): a user who
// installed an editor and changed a setting, the editor command included, sees it
// without a restart. ListEditorApps' refresh does the same on demand. The returned func
// stops it.
func startEditorAppsRefresh(ctx context.Context, apps editorAppsRefresher, b *bus.Bus) func() {
	ctx, cancel := context.WithCancel(ctx)
	sub := bus.Subscribe[settings.Changed](b, 16)
	var wg sync.WaitGroup
	wg.Go(func() {
		defer sub.Close()
		for {
			select {
			case <-ctx.Done():
				return
			case <-sub.C():
				apps.RefreshEditorApps()
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}
