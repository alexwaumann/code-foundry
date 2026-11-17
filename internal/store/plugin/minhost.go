package plugin

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry"
	"github.com/alexwaumann/code-foundry/internal/store/update"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// A plugin version may need a newer Code Foundry than this one: its manifest's
// minHostVersion (docs/notes/plugin-min-host-version.md). update.AtLeast is the rule
// (a dev build runs anything; a tip counts as its base version). Such a version is never
// installed (registry entries are refused before the download, releases after reading
// the downloaded manifest, before anything is put in place), never offered as an update
// (Plugin.HeldUpdate instead of Plugin.Update) and, already on disk, never started.

// HostVersion is this Code Foundry's version without a leading v, for messages.
func (m *Manager) HostVersion() string { return strings.TrimPrefix(m.opts.HostVersion, "v") }

// hostRuns reports whether this Code Foundry runs a plugin version needing minimum.
func (m *Manager) hostRuns(minimum string) bool { return update.AtLeast(m.opts.HostVersion, minimum) }

// HeldUpdate is an update offer this Code Foundry (Host, no leading v) is too old for.
type HeldUpdate struct {
	UpdateOffer
	Host string
}

// NeedsHostError is a plugin version this Code Foundry is too old for.
type NeedsHostError struct {
	Name, Version string
	// MinHost is the version's minHostVersion; Host this Code Foundry's version.
	MinHost, Host string
}

func (e *NeedsHostError) Error() string {
	return fmt.Sprintf("%s %s needs Code Foundry %s or newer; this is %s", e.Name, e.Version, e.MinHost, e.Host)
}

// needsHost is the error for name at version needing minimum, nil when this Code Foundry runs it.
func (m *Manager) needsHost(name, version, minimum string) error {
	if m.hostRuns(minimum) {
		return nil
	}
	return &NeedsHostError{Name: name, Version: version, MinHost: minimum, Host: m.HostVersion()}
}

// releaseMinHost reads the minHostVersion of repo's release tag: it downloads this
// platform's tarball into a staging folder (removed after), checks its hash when the
// release has checksums, and reads plugin.json out of it. A release has no index entry
// to say it, so the update check of a plugin installed from a GitHub release asks this
// once per new version (checkReleases keeps the answer).
func (m *Manager) releaseMinHost(ctx context.Context, repo, tag string) (string, error) {
	staging, err := m.stagingRoot()
	if err != nil {
		return "", err
	}
	work, err := os.MkdirTemp(staging, "check-")
	if err != nil {
		return "", fmt.Errorf("plugin: staging: %w", err)
	}
	defer func() { _ = os.RemoveAll(work) }()
	f := m.opts.Registry.Fetcher()
	rel, err := f.ResolveRelease(ctx, repo, tag, registry.Platform(), work)
	if err != nil {
		return "", err
	}
	tarball := filepath.Join(work, rel.AssetName)
	if err := f.Download(ctx, rel.Asset.URL, tarball, nil); err != nil {
		return "", err
	}
	if rel.Asset.SHA256 != "" {
		if err := registry.Verify(tarball, rel.Asset.SHA256); err != nil {
			return "", err
		}
	}
	data, err := registry.ReadManifest(tarball)
	if err != nil {
		return "", err
	}
	mf, _, err := pluginsdk.ParseManifest(data)
	if err != nil {
		return "", err
	}
	return mf.MinHostVersion, nil
}
