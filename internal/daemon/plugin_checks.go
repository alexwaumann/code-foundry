package daemon

import (
	"context"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// pluginChecks is the plugin store's InvalidatePullRequestChecks (plugin.Manager).
type pluginChecks interface {
	InvalidatePullRequestChecks(slug string, number int)
}

// startPluginChecks invalidates the plugins' pr.checks fact when the gh store says a
// pull request's checks may have changed: a poll saw its head pushed or its check
// rollup move (PullRequestChanged), or its detail changed or went stale
// (PullRequestDetailUpdated: a poll, a merge, a review request). The fact's age refresh
// is only a 10 minute safety net behind this.
func startPluginChecks(ctx context.Context, b *bus.Bus, plugins pluginChecks) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	changed := bus.Subscribe[gh.PullRequestChanged](b, 512) // one per pull request per poll, back to back
	detail := bus.Subscribe[gh.PullRequestDetailUpdated](b, 64)
	var wg sync.WaitGroup
	wg.Go(func() {
		defer changed.Close()
		defer detail.Close()
		for {
			select {
			case <-ctx.Done():
				return
			case e := <-changed.C():
				if e.Has(gh.ChangeHeadPushed, gh.ChangeChecks) {
					plugins.InvalidatePullRequestChecks(e.Slug, e.Number)
				}
			case e := <-detail.C():
				plugins.InvalidatePullRequestChecks(e.Slug, e.Number)
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}
