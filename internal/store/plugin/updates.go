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

// UpdateOffer is a newer version of an installed plugin that a registry lists, or, for a
// plugin installed straight from a GitHub repository that no registry lists, that the
// repository's latest release is.
type UpdateOffer struct {
	Version string
	// Registry is the URL of the registry listing it (https://github.com/<owner>/<repo>
	// for a release).
	Registry string
	// Ref installs it: "<owner>/<repo>@<tag>" for a plugin installed from a release (its
	// repository's latest, or the version a registry entry of that repository lists);
	// "" installs the name from the registries.
	Ref string
}

// RegistryChanged is published when the merged index changes (an entry added, removed,
// bumped, or moved to another registry) or the configured registries do: clients
// showing Browse read it again. Epoch grows by one per change in this daemon's lifetime.
type RegistryChanged struct{ Epoch uint64 }

func (RegistryChanged) isPluginEvent() {}

// Relation is how a registry entry stands to the installed plugin of its name: the one
// decision behind Browse's rows, Plugin.Update and `plugin update --check`
// (docs/notes/plugins-browse-offer.md). Clients read it; they do not derive it.
type Relation string

const (
	// RelationNotInstalled: no plugin of the name is installed. Install.
	RelationNotInstalled Relation = "not_installed"
	// RelationInstalled: installed from the entry's source, at its version or newer.
	RelationInstalled Relation = "installed"
	// RelationUpdate: installed from the entry's source, older. Update.
	RelationUpdate Relation = "update"
	// RelationDev: a dev link of the name. Neither installed over nor updated from here.
	RelationDev Relation = "dev"
	// RelationOtherSource: installed from another source (another registry, another
	// repository's releases, or put in plugins/ by hand). Neither Install nor Update: the
	// entry's package would take the name over (origin.go), which only
	// `plugin install --force` does.
	RelationOtherSource Relation = "other_source"
)

// sameSource reports whether entry e comes from the source p was installed from: the
// registry it was installed from, or, for a plugin installed from a GitHub release, an
// entry of that repository (whichever registry lists it: the registry only points at
// the releases it came from). A package put in plugins/ by hand, or linked, has no
// source a registry entry can match.
func sameSource(p Plugin, e registry.Entry) bool {
	if p.Installed == nil {
		return false
	}
	switch p.Installed.Kind {
	case KindRegistry:
		return p.Installed.Source == e.Registry
	case KindGitHub:
		return e.Repo != "" && strings.EqualFold(p.Installed.Source, e.Repo)
	}
	return false
}

// relate is entry e's relation to p, the installed plugin of its name (nil when none).
func relate(p *Plugin, e registry.Entry) Relation {
	switch {
	case p == nil:
		return RelationNotInstalled
	case p.Dev:
		return RelationDev
	case !sameSource(*p, e):
		return RelationOtherSource
	case p.Manifest.Version != "" && registry.Newer(e.Version, p.Manifest.Version):
		return RelationUpdate
	}
	return RelationInstalled
}

// SourceLabel is where p was installed from, short, for "installed from <label>": a
// registry's URL without its scheme (and github.com/), owner/repo for a release, the
// folder of a dev link, or "the plugins folder" for a package put there by hand.
func SourceLabel(p Plugin) string {
	switch {
	case p.Dev && p.DevPath != "":
		return p.DevPath
	case p.Installed == nil:
		return "the plugins folder"
	case p.Installed.Kind == KindRegistry:
		return ShortURL(p.Installed.Source)
	}
	return p.Installed.Source
}

// ShortURL is a registry or repository URL without its scheme and github.com host:
// "alexwaumann/code-foundry-plugins", "127.0.0.1:8765/index.json" (the GUI's
// shortSource).
func ShortURL(u string) string {
	u = strings.TrimPrefix(strings.TrimPrefix(u, "https://"), "http://")
	return strings.TrimPrefix(u, "github.com/")
}

// offerFor is the update offered for p, a non-dev plugin, and only ever from the source
// it was installed from (relate): its registry's entry; for a GitHub release install, a
// registry entry of the same repository (installed as that repository's release, so it
// stays a release install of the same origin), else the repository's latest release
// (releases, from the last CheckUpdates). Another source's entry of the name is never an
// offer: installing it would be a takeover (origin.go), which only
// `plugin install --force` does. Nor is anything an offer for a package put in plugins/
// by hand (no source to match).
func offerFor(p Plugin, merged registry.Merged, releases map[string]UpdateOffer) (UpdateOffer, bool) {
	if p.Dev || p.Manifest.Version == "" {
		return UpdateOffer{}, false
	}
	e, listed := merged.Entry(p.Name)
	if listed && sameSource(p, e) {
		if relate(&p, e) != RelationUpdate {
			return UpdateOffer{}, false
		}
		o := UpdateOffer{Version: e.Version, Registry: e.Registry}
		if p.Installed.Kind == KindGitHub {
			o.Ref = p.Installed.Source + "@v" + e.Version
		}
		return o, true
	}
	if fromRepo(p, merged) {
		r, ok := releases[p.Name]
		if !ok || !registry.Newer(r.Version, p.Manifest.Version) {
			return UpdateOffer{}, false
		}
		return r, true
	}
	return UpdateOffer{}, false
}

// fromRepo reports whether p was installed from a GitHub release that no registry entry
// of the same repository lists: its updates come from the repository's releases.
func fromRepo(p Plugin, merged registry.Merged) bool {
	if p.Installed == nil || p.Installed.Kind != KindGitHub {
		return false
	}
	e, ok := merged.Entry(p.Name)
	return !ok || !sameSource(p, e)
}

// checkReleases asks, once per update check, each plugin installed from a GitHub
// repository that no registry lists for its latest release, and records the offers.
// A failure keeps the last answer (logged at debug: gh may be offline).
func (m *Manager) checkReleases(ctx context.Context) {
	m.inst.mu.Lock()
	merged := m.inst.merged
	m.inst.mu.Unlock()
	for _, p := range m.Snapshot().Plugins {
		if p.Dev || !fromRepo(p, merged) {
			continue
		}
		repo := p.Installed.Source
		version, tag, err := m.opts.Registry.Fetcher().LatestVersion(ctx, repo)
		if err != nil {
			m.log.Debug("plugin update check: release", "plugin", p.Name, "repo", repo, "err", err)
			continue
		}
		o := UpdateOffer{Version: version, Registry: "https://github.com/" + repo, Ref: repo + "@" + tag}
		m.inst.mu.Lock()
		if m.inst.releases == nil {
			m.inst.releases = map[string]UpdateOffer{}
		}
		old, had := m.inst.releases[p.Name]
		m.inst.releases[p.Name] = o
		m.inst.mu.Unlock()
		if !had || old != o {
			m.update(p.Name, nil, func(*entry) {})
		}
	}
}

// setMerged records the registries' latest index and publishes what changed: each
// plugin whose update offer changed, and RegistryChanged when the index did.
func (m *Manager) setMerged(merged registry.Merged) {
	m.inst.mu.Lock()
	m.inst.merged = merged
	releases := m.inst.releases
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
		o, ok := offerFor(p, merged, releases)
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
	// Ref installs it (UpdateOffer.Ref): "" installs Name from the registries.
	Ref string
	// Updated: Update installed it. Error: it failed (the others still ran).
	Updated bool
	Error   string
	// Disabled says why an enabled plugin was left disabled after the update (it asks
	// for more permissions than were granted: enable it again to review them).
	Disabled string
	// InstalledFrom, when set, makes this no offer: Registry lists Version, newer, but the
	// plugin was installed from another source (SourceLabel), so it is not offered and
	// Update skips it (RelationOtherSource; `plugin install --force` switches).
	InstalledFrom string
}

// CheckUpdates reads the registries (the cached indexes within their TTL unless
// refresh) and returns the installed plugins their own source lists a newer version of
// (offerFor), and those installed from a GitHub repository no registry lists whose
// latest release is newer (one `gh release view` per such plugin per call). After the
// offers come the entries that are no offer because the plugin came from elsewhere
// (InstalledFrom set) but list a newer version. It installs nothing; the snapshot's
// Plugin.Update carries the same offers.
func (m *Manager) CheckUpdates(ctx context.Context, refresh bool) ([]PluginUpdate, error) {
	if m.opts.Registry == nil {
		return nil, fmt.Errorf("%w: this daemon has no plugin registry client", ErrFailedPrecondition)
	}
	m.setMerged(m.opts.Registry.Read(ctx, refresh))
	m.checkReleases(ctx)
	snap := m.Snapshot()
	var out []PluginUpdate
	for _, p := range snap.Plugins {
		if p.Update != nil {
			out = append(out, PluginUpdate{Name: p.Name, Current: p.Manifest.Version, Version: p.Update.Version,
				Registry: p.Update.Registry, Ref: p.Update.Ref})
		}
	}
	m.inst.mu.Lock()
	merged := m.inst.merged
	m.inst.mu.Unlock()
	for _, e := range merged.Entries {
		p, ok := snap.Plugin(e.Name)
		if !ok || relate(&p, e) != RelationOtherSource || p.Manifest.Version == "" || !registry.Newer(e.Version, p.Manifest.Version) {
			continue
		}
		if p.Update != nil && !registry.Newer(e.Version, p.Update.Version) {
			continue // its own source offers as much
		}
		out = append(out, PluginUpdate{Name: p.Name, Current: p.Manifest.Version, Version: e.Version, Registry: e.Registry,
			InstalledFrom: SourceLabel(p)})
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
		if u.InstalledFrom != "" {
			continue // not an offer (another source lists it)
		}
		wasEnabled := false
		if p, ok := m.Snapshot().Plugin(u.Name); ok {
			wasEnabled = p.Enabled
		}
		ref := u.Name
		if u.Ref != "" {
			ref = u.Ref
		}
		res, err := m.Install(ctx, InstallRequest{Ref: ref})
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
	// Relation is the entry's relation to Installed: what Browse offers (Install, Update,
	// or nothing).
	Relation Relation
	// InstalledFrom is where Installed came from (SourceLabel) when Relation is
	// RelationOtherSource; else empty.
	InstalledFrom string
}

// BrowseResult is Browse's answer.
type BrowseResult struct {
	Entries    []BrowseEntry
	Registries []registry.Status
}

// Browse returns every registry's plugins merged by name (the first registry listing a
// name wins), each with the installed plugin of that name and its relation to it (the
// decision offerFor makes), and each registry's state.
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
		be.Relation = relate(be.Installed, e)
		if be.Relation == RelationOtherSource {
			be.InstalledFrom = SourceLabel(*be.Installed)
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
