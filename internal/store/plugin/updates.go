package plugin

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry"
)

// Browse, update checks and updates (docs/notes/plugins-7-registry.md). The registries'
// last index is kept in installState.merged; every plugin's Plugin.Update is computed from
// it when the snapshot is built, so it is never stale against the installed version.
// Nothing here installs anything on its own: CheckUpdates only records offers, and
// Update runs only when asked.

// UpdateOffer is a newer version of an installed plugin that a registry lists.
type UpdateOffer struct {
	Version string
	// Registry is the URL of the registry listing it.
	Registry string
}

// RegistryChanged is published when the merged index changes (an entry added, removed,
// bumped, or moved to another registry) or the configured registries do: clients
// showing Browse read it again. Epoch grows by one per change in this daemon's lifetime.
type RegistryChanged struct{ Epoch uint64 }

func (RegistryChanged) isPluginEvent() {}

// offerFor is the update a registry offers for p: a non-dev plugin whose name the merged
// index lists with a newer version. A plugin installed from a GitHub release is only
// matched by an entry of the same repository, one installed from a registry only by that
// registry's entry (another plugin may share its name).
func offerFor(p Plugin, merged registry.Merged) (UpdateOffer, bool) {
	if p.Dev || p.Manifest.Version == "" {
		return UpdateOffer{}, false
	}
	e, ok := merged.Entry(p.Name)
	if !ok || !registry.Newer(e.Version, p.Manifest.Version) {
		return UpdateOffer{}, false
	}
	if p.Installed != nil && p.Installed.Kind == KindGitHub && !strings.EqualFold(p.Installed.Source, e.Repo) {
		return UpdateOffer{}, false
	}
	// Nor is one from a registry by another registry's entry of the name (a registry
	// added first, or the first one dropping it): installing that would be a takeover
	// (origin.go), which only `plugin install --force` does.
	if p.Installed != nil && p.Installed.Kind == KindRegistry && p.Installed.Source != e.Registry {
		return UpdateOffer{}, false
	}
	return UpdateOffer{Version: e.Version, Registry: e.Registry}, true
}

// setMerged records the registries' latest index and publishes what changed: each
// plugin whose update offer changed, and RegistryChanged when the index did.
func (m *Manager) setMerged(merged registry.Merged) {
	m.inst.mu.Lock()
	m.inst.merged = merged
	fp := merged.Fingerprint()
	changed := fp != m.inst.fp
	if changed {
		m.inst.fp = fp
		m.inst.epoch++
	}
	epoch := m.inst.epoch
	m.inst.mu.Unlock()
	for _, p := range m.Snapshot().Plugins {
		// The record matters for offerFor; the snapshot's is current.
		o, ok := offerFor(p, merged)
		if (p.Update == nil) == !ok && (p.Update == nil || *p.Update == o) {
			continue
		}
		m.update(p.Name, nil, func(*entry) {})
	}
	if changed {
		bus.Publish[Event](m.opts.Bus, RegistryChanged{Epoch: epoch})
	}
}

// SetRegistries points the registry client at the plugins.registries setting's
// registries and re-reads their cached indexes (no network).
func (m *Manager) SetRegistries(locs []registry.Location) {
	if m.opts.Registry == nil {
		return
	}
	if m.opts.Registry.SetLocations(locs) {
		m.setMerged(m.opts.Registry.Cached())
	}
}

// PluginUpdate is one plugin's update: offered (CheckUpdates) or done (Update).
type PluginUpdate struct {
	Name     string
	Current  string
	Version  string
	Registry string
	// Updated: Update installed it. Error: it failed (the others still ran).
	Updated bool
	Error   string
	// Disabled says why an enabled plugin was left disabled after the update (it asks
	// for more permissions than were granted: enable it again to review them).
	Disabled string
}

// CheckUpdates reads the registries (the cached indexes within their TTL unless
// refresh) and returns the installed plugins a registry lists a newer version of. It
// installs nothing; the snapshot's Plugin.Update carries the same offers.
func (m *Manager) CheckUpdates(ctx context.Context, refresh bool) ([]PluginUpdate, error) {
	if m.opts.Registry == nil {
		return nil, fmt.Errorf("%w: this daemon has no plugin registry client", ErrFailedPrecondition)
	}
	m.setMerged(m.opts.Registry.Read(ctx, refresh))
	var out []PluginUpdate
	for _, p := range m.Snapshot().Plugins {
		if p.Update != nil {
			out = append(out, PluginUpdate{Name: p.Name, Current: p.Manifest.Version, Version: p.Update.Version, Registry: p.Update.Registry})
		}
	}
	return out, nil
}

// Update installs the offered update of one plugin (name) or of every plugin with one.
// An enabled plugin stays enabled unless the new version asks for more permissions than
// were granted. check only reports the offers. A dev plugin is never updated.
func (m *Manager) Update(ctx context.Context, name string, check, refresh bool) ([]PluginUpdate, error) {
	if name != "" {
		p, ok := m.Snapshot().Plugin(name)
		if !ok {
			return nil, fmt.Errorf("%w: no plugin %q", ErrNotFound, name)
		}
		if p.Dev {
			return nil, fmt.Errorf("%w: %s is a dev plugin (linked from %s): rebuild it there, or `plugin install %s --force` to replace the link", ErrFailedPrecondition, name, p.DevPath, name)
		}
	}
	offers, err := m.CheckUpdates(ctx, refresh)
	if err != nil {
		return nil, err
	}
	if name != "" {
		offers = slices.DeleteFunc(offers, func(u PluginUpdate) bool { return u.Name != name })
	}
	if check {
		return offers, nil
	}
	for i := range offers {
		u := &offers[i]
		wasEnabled := false
		if p, ok := m.Snapshot().Plugin(u.Name); ok {
			wasEnabled = p.Enabled
		}
		res, err := m.Install(ctx, InstallRequest{Ref: u.Name})
		if err != nil {
			u.Error = err.Error()
			continue
		}
		u.Updated, u.Version = res.Changed, res.Version
		if wasEnabled && !res.Plugin.Enabled {
			u.Disabled = res.Plugin.DisabledReason
		}
	}
	return offers, nil
}

// BrowseEntry is a registry entry with what is installed of it.
type BrowseEntry struct {
	registry.Entry
	// Installed is the plugin as installed, when it is.
	Installed *Plugin
}

// BrowseResult is Browse's answer.
type BrowseResult struct {
	Entries    []BrowseEntry
	Registries []registry.Status
}

// Browse returns every registry's plugins merged by name (the first registry listing a
// name wins), each with the installed plugin of that name, and each registry's state.
// refresh reads every registry again instead of its cached index.
func (m *Manager) Browse(ctx context.Context, refresh bool) (BrowseResult, error) {
	if m.opts.Registry == nil {
		return BrowseResult{}, fmt.Errorf("%w: this daemon has no plugin registry client", ErrFailedPrecondition)
	}
	merged := m.opts.Registry.Read(ctx, refresh)
	m.setMerged(merged)
	snap := m.Snapshot()
	out := BrowseResult{Entries: make([]BrowseEntry, 0, len(merged.Entries)), Registries: merged.Registries}
	for _, e := range merged.Entries {
		be := BrowseEntry{Entry: e}
		if p, ok := snap.Plugin(e.Name); ok {
			be.Installed = &p
		}
		out.Entries = append(out.Entries, be)
	}
	return out, nil
}

// Installer is the plugin store's registry half: browse, install, update, uninstall.
// *Manager implements it.
type Installer interface {
	Browse(ctx context.Context, refresh bool) (BrowseResult, error)
	Install(ctx context.Context, req InstallRequest) (InstallResult, error)
	Update(ctx context.Context, name string, check, refresh bool) ([]PluginUpdate, error)
	Uninstall(ctx context.Context, name string, purge bool) (UninstallResult, error)
}

var _ Installer = (*Manager)(nil)
