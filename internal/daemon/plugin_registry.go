package daemon

import (
	"context"
	"log/slog"
	"path/filepath"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/update"
)

// The plugin registries (docs/notes/plugins-7-registry.md): the client the plugin store
// installs through, the plugins.registries setting, and the update check.

// pluginRegistryClient reads the plugins.registries setting's registries, github.com
// ones with the user's gh (advanced.gh_path, else PATH and Homebrew), and caches their
// indexes in plugins/.registries.
func pluginRegistryClient(p paths.Paths, cfg settings.Settings, log *slog.Logger) *registry.Client {
	c := registry.NewClient(registry.Options{
		CacheDir: filepath.Join(p.Plugins(), plugin.RegistryCacheDir),
		Fetcher:  registry.Fetcher{Gh: registry.ExecGh{Path: settings.ExpandedPath(cfg.Advanced.GhPath)}},
		Log:      log,
	})
	locs, err := registry.ParseList(cfg.Plugins.Registries)
	if err != nil {
		log.Warn("plugins.registries", "err", err)
	}
	c.SetLocations(locs)
	return c
}

// applyPluginRegistries keeps the plugin store on plugins.registries, now and on every
// settings change.
func applyPluginRegistries(st *settings.Store, plugins *plugin.Manager) {
	st.OnChange(func(snap *settings.Snapshot) {
		locs, _ := registry.ParseList(snap.Settings.Plugins.Registries) // validated: rejected values fell back
		plugins.SetRegistries(locs)
	})
}

// pluginUpdateChecker is the plugin store's update check (*plugin.Manager).
type pluginUpdateChecker interface {
	CheckUpdates(ctx context.Context, refresh bool) ([]plugin.PluginUpdate, error)
}

// startPluginUpdateChecks rides the app's update check: whenever the updater has checked
// (an update.Event with a new LastCheckedAt), the registries are read (each from its cache
// while younger than an hour) and the plugins' update offers refreshed, which publishes
// a plugin change for each plugin whose offer changed. A build whose updater is disabled
// (a dev build) checks on the same cadence by itself. Nothing is ever installed. stop
// waits for a check in flight.
func startPluginUpdateChecks(ctx context.Context, log *slog.Logger, b *bus.Bus, u update.Service, plugins pluginUpdateChecker) (stop func()) {
	return onUpdateChecks(ctx, b, u, func(ctx context.Context) {
		ups, err := plugins.CheckUpdates(ctx, false)
		switch {
		case ctx.Err() != nil:
		case err != nil:
			log.Warn("plugin update check failed", "err", err)
		default:
			log.Info("plugin update check", "updates", len(ups))
		}
	})
}
