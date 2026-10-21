package plugin

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Install, uninstall and dev links (docs/notes/plugins-7-registry.md).
//
// An install resolves its ref (a registry name, a GitHub release, or a folder), downloads
// this platform's tarball into plugins/.staging/<name>-*/, checks its SHA-256 (the index
// entry's, or the release's checksums file), unpacks it, validates the package (name,
// version, protocol, exec, and permissions within what the registry entry lists), then
// swaps it in for plugins/<name> under opMu and re-applies the plugin: an enabled plugin
// restarts on the new package and stays enabled unless it now asks for more than was
// granted (then it is disabled until the user consents again, as on any rescan). A new
// plugin is disabled until enabled with consent. The data dir is never touched.

// StagingDir is plugins/<StagingDir>: downloads and unpacked packages before the swap,
// and replaced packages until they are deleted. Discovery skips dot directories.
const StagingDir = ".staging"

// RegistryCacheDir is plugins/<RegistryCacheDir>: the registries' cached indexes.
const RegistryCacheDir = ".registries"

// InstallPhase is a step of an install, reported on the bus as InstallProgress.
type InstallPhase int

// Install phases in order; Done or Failed ends one.
const (
	InstallResolving InstallPhase = iota + 1
	InstallDownloading
	InstallVerifying
	InstallExtracting
	InstallSwapping
	InstallDone
	InstallFailed
)

func (p InstallPhase) String() string {
	switch p {
	case InstallResolving:
		return "resolving"
	case InstallDownloading:
		return "downloading"
	case InstallVerifying:
		return "verifying"
	case InstallExtracting:
		return "extracting"
	case InstallSwapping:
		return "installing"
	case InstallDone:
		return "done"
	case InstallFailed:
		return "failed"
	}
	return fmt.Sprintf("InstallPhase(%d)", int(p))
}

// InstallProgress is published on the bus at every step of an install or update.
type InstallProgress struct {
	// Ref is what was asked for; Name and Version are known once resolved.
	Ref, Name, Version string
	Phase              InstallPhase
	// Message is the step in words, or the failure.
	Message string
	// Bytes downloaded so far (HTTP downloads; gh reports none).
	Bytes int64
}

func (InstallProgress) isPluginEvent() {}

// InstallRequest is Install's input.
type InstallRequest struct {
	// Ref is a registry plugin name[@version], <owner>/<repo>[@vX.Y.Z] (a GitHub
	// release, by the tarball naming convention), or an absolute folder (or ~/…) to link
	// like plugin dev.
	Ref string
	// Force replaces a dev link with the package (or a package with a link), and
	// reinstalls the version already installed.
	Force bool
	// Enable turns the plugin on afterwards; Consent consents to its permissions
	// (without it, a plugin that needs consent stays disabled and the result says so).
	Enable, Consent bool
	// Refresh reads the registries again instead of their cached indexes (1 h).
	Refresh bool
}

// InstallResult is Install's answer.
type InstallResult struct {
	Plugin  Plugin
	Kind    InstallKind
	Source  string
	Version string
	// Previous is the version replaced ("" for a new install).
	Previous string
	// Changed is false when that version was installed already (nothing was done).
	Changed bool
	// Warnings: an unverified download, manifest warnings.
	Warnings []string
	// NeedsConsent: Enable was asked but the user has to consent first (Consent text).
	NeedsConsent bool
	Consent      string
	// RemovedThreads are the ids of the threads of the plugin a forced takeover replaced.
	RemovedThreads []string
}

// UninstallResult is Uninstall's answer.
type UninstallResult struct {
	// Removed is the package directory (or the dev link) removed; "" when there was none.
	Removed string
	// Purged lists what --purge deleted, in words.
	Purged []string
	// RemovedThreads are the ids of the plugin's threads, removed.
	RemovedThreads []string
}

// installState is the store's install bookkeeping. Lock order: Manager.mu before mu.
type installState struct {
	mu      sync.Mutex
	records map[string]InstallRecord
	busy    map[string]bool
	// merged is the registries' last index (updates.go); fp its fingerprint and epoch
	// counts its changes.
	merged registry.Merged
	fp     string
	epoch  uint64
	// releases are the latest releases of the plugins installed from a GitHub repository
	// that no registry lists, by plugin name, as the last update check found them.
	releases map[string]UpdateOffer
}

func (s *installState) record(name string) (InstallRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.records[name]
	return r, ok
}

func (s *installState) setRecord(name string, r *InstallRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.records == nil {
		s.records = map[string]InstallRecord{}
	}
	if r == nil {
		delete(s.records, name)
	} else {
		s.records[name] = *r
	}
}

// begin marks name as being installed; false when it already is.
func (s *installState) begin(name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.busy[name] {
		return false
	}
	if s.busy == nil {
		s.busy = map[string]bool{}
	}
	s.busy[name] = true
	return true
}

func (s *installState) end(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.busy, name)
}

// loadInstalls reads plugin_installs and the registries' cached index (no network), so
// the first snapshot already says where packages came from and which have updates.
func (m *Manager) loadInstalls(ctx context.Context) {
	recs, err := loadInstallRows(ctx, m.opts.DB)
	if err != nil {
		m.log.Warn("plugin: install records", "err", err)
	}
	m.inst.mu.Lock()
	m.inst.records = recs
	m.inst.mu.Unlock()
	if m.opts.Registry != nil {
		m.setMerged(m.opts.Registry.Cached())
	}
}

// installInfo fills p's Installed and Update. m.mu held.
func (m *Manager) installInfo(p *Plugin) {
	m.inst.mu.Lock()
	defer m.inst.mu.Unlock()
	if r, ok := m.inst.records[p.Name]; ok {
		p.Installed = &r
	}
	if o, ok := offerFor(*p, m.inst.merged, m.inst.releases); ok {
		p.Update = &o
	}
}

func (m *Manager) progress(ev InstallProgress) {
	bus.Publish[Event](m.opts.Bus, ev)
}

// parsedRef is an install ref taken apart.
type parsedRef struct {
	kind InstallKind
	// name (registry), repo (github) or the folder (path).
	target string
	// version (registry, no v) or tag (github, with v); "" for the latest.
	version string
}

func parseRef(ref string) (parsedRef, error) {
	ref = strings.TrimSpace(ref)
	switch {
	case ref == "":
		return parsedRef{}, fmt.Errorf("%w: what to install: a plugin name, owner/repo, or a folder", ErrInvalidArgument)
	case strings.HasPrefix(ref, "/") || strings.HasPrefix(ref, "~"):
		dir, err := command.ExpandPath(ref)
		if err != nil {
			return parsedRef{}, fmt.Errorf("%w: %v", ErrInvalidArgument, err)
		}
		return parsedRef{kind: KindPath, target: dir}, nil
	case strings.HasPrefix(ref, "."):
		return parsedRef{}, fmt.Errorf("%w: %q is a relative path: give an absolute one, or run `code-foundry plugin dev %s`, which resolves it", ErrInvalidArgument, ref, ref)
	case strings.Contains(ref, "/"):
		repo, tag, ok := registry.ParseRepoRef(ref)
		if !ok {
			return parsedRef{}, fmt.Errorf("%w: %q is not owner/repo[@vX.Y.Z]", ErrInvalidArgument, ref)
		}
		if tag != "" {
			tag = "v" + strings.TrimPrefix(tag, "v")
			if !registry.ValidVersion(tag[1:]) {
				return parsedRef{}, fmt.Errorf("%w: %q: the tag must be vX.Y.Z", ErrInvalidArgument, ref)
			}
		}
		return parsedRef{kind: KindGitHub, target: repo, version: tag}, nil
	}
	name, version, _ := strings.Cut(ref, "@")
	version = strings.TrimPrefix(version, "v")
	if !registry.ValidName(name) {
		return parsedRef{}, fmt.Errorf("%w: %q is not a plugin name", ErrInvalidArgument, name)
	}
	if version != "" && !registry.ValidVersion(version) {
		return parsedRef{}, fmt.Errorf("%w: %q is not a version (X.Y.Z)", ErrInvalidArgument, version)
	}
	return parsedRef{kind: KindRegistry, target: name, version: version}, nil
}

// plan is a resolved install: what to download and what it must contain.
type plan struct {
	name, version string
	artifact      registry.Artifact
	kind          InstallKind
	source        string
	// perms, when set, bounds the manifest's permissions (the registry entry's).
	perms    *pluginsdk.Permissions
	warnings []string
}

func (m *Manager) stagingRoot() (string, error) {
	dir := filepath.Join(m.opts.Dir, StagingDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("plugin: staging: %w", err)
	}
	return dir, nil
}

// resolve finds what a registry or GitHub ref installs.
func (m *Manager) resolve(ctx context.Context, ref parsedRef, refresh bool) (plan, error) {
	reg := m.opts.Registry
	if reg == nil {
		return plan{}, fmt.Errorf("%w: this daemon has no plugin registry client", ErrFailedPrecondition)
	}
	platform := registry.Platform()
	staging, err := m.stagingRoot()
	if err != nil {
		return plan{}, err
	}
	if ref.kind == KindGitHub {
		rel, err := reg.Fetcher().ResolveRelease(ctx, ref.target, ref.version, platform, staging)
		if err != nil {
			return plan{}, registryError(err)
		}
		p := plan{name: rel.Name, version: rel.Version, artifact: rel.Asset, kind: KindGitHub, source: ref.target}
		if rel.Asset.SHA256 == "" {
			p.warnings = append(p.warnings, fmt.Sprintf("release %s of %s has no checksums file: the download is not verified", rel.Tag, ref.target))
		}
		return p, nil
	}
	merged := reg.Read(ctx, refresh)
	e, ok := merged.Entry(ref.target)
	if !ok && !refresh {
		// The cached index may predate the plugin.
		merged = reg.Read(ctx, true)
		e, ok = merged.Entry(ref.target)
	}
	m.setMerged(merged)
	if !ok && len(merged.Registries) == 0 {
		return plan{}, fmt.Errorf("%w: no plugin registry is configured to look up %q in (settings plugins.registries); a release installs as <owner>/<repo>, a folder by its path", ErrNotFound, ref.target)
	}
	if !ok {
		msg := fmt.Sprintf("no plugin %q in the registries (%s)", ref.target, strings.Join(registryURLs(merged), ", "))
		if err := merged.Err(); err != nil {
			msg += "; " + err.Error()
		}
		return plan{}, fmt.Errorf("%w: %s", ErrNotFound, msg)
	}
	if e.Protocol != 0 && e.Protocol != pluginsdk.ProtocolVersion {
		return plan{}, fmt.Errorf("%w: %s %s speaks protocol %d, this Code Foundry speaks %d", ErrFailedPrecondition, e.Name, e.Version, e.Protocol, pluginsdk.ProtocolVersion)
	}
	if ref.version != "" && ref.version != e.Version {
		// The index lists the latest version only; an older one comes from the plugin's
		// releases, checked against their checksums file.
		if e.Repo == "" {
			return plan{}, fmt.Errorf("%w: %s lists %s %s only, and no repository to find %s in", ErrNotFound, e.Registry, e.Name, e.Version, ref.version)
		}
		rel, err := reg.Fetcher().ResolveRelease(ctx, e.Repo, "v"+ref.version, platform, staging)
		if err != nil {
			return plan{}, registryError(err)
		}
		if rel.Name != e.Name {
			return plan{}, fmt.Errorf("%w: release v%s of %s is plugin %s, not %s", ErrFailedPrecondition, ref.version, e.Repo, rel.Name, e.Name)
		}
		p := plan{name: e.Name, version: rel.Version, artifact: rel.Asset, kind: KindRegistry, source: e.Registry}
		if rel.Asset.SHA256 == "" {
			p.warnings = append(p.warnings, fmt.Sprintf("release %s of %s has no checksums file: the download is not verified", rel.Tag, e.Repo))
		}
		return p, nil
	}
	art, ok := e.Artifact(platform)
	if !ok {
		return plan{}, fmt.Errorf("%w: %s %s has no %s build", ErrNotFound, e.Name, e.Version, platform)
	}
	perms := e.Permissions
	return plan{name: e.Name, version: e.Version, artifact: art, kind: KindRegistry, source: e.Registry, perms: &perms}, nil
}

func registryURLs(m registry.Merged) []string {
	out := make([]string, len(m.Registries))
	for i, r := range m.Registries {
		out[i] = r.URL
	}
	return out
}

// registryError maps the registry package's errors onto the store's.
func registryError(err error) error {
	switch {
	case errors.Is(err, registry.ErrNotFound):
		return fmt.Errorf("%w: %s", ErrNotFound, strings.TrimPrefix(err.Error(), registry.ErrNotFound.Error()+": "))
	case errors.Is(err, registry.ErrHashMismatch):
		return fmt.Errorf("%w: %v", ErrFailedPrecondition, err)
	}
	return err
}

// Install installs (or reinstalls, or updates) a plugin package. See InstallRequest.
func (m *Manager) Install(ctx context.Context, req InstallRequest) (InstallResult, error) {
	if m.isClosed() {
		return InstallResult{}, ErrClosed
	}
	ref, err := parseRef(req.Ref)
	if err != nil {
		return InstallResult{}, err
	}
	if ref.kind == KindPath {
		return m.installLink(ctx, ref.target, req)
	}
	m.progress(InstallProgress{Ref: req.Ref, Phase: InstallResolving, Message: "resolving " + req.Ref})
	p, err := m.resolve(ctx, ref, req.Refresh)
	if err != nil {
		m.progress(InstallProgress{Ref: req.Ref, Phase: InstallFailed, Message: err.Error()})
		return InstallResult{}, err
	}
	if !m.inst.begin(p.name) {
		return InstallResult{}, fmt.Errorf("%w: plugin %s is being installed already", ErrFailedPrecondition, p.name)
	}
	defer m.inst.end(p.name)
	res, err := m.install(ctx, req, p)
	if err != nil {
		m.progress(InstallProgress{Ref: req.Ref, Name: p.name, Version: p.version, Phase: InstallFailed, Message: err.Error()})
		return InstallResult{}, err
	}
	msg := fmt.Sprintf("installed %s %s", p.name, p.version)
	if !res.Changed {
		msg = fmt.Sprintf("%s %s is installed already", p.name, p.version)
	}
	m.progress(InstallProgress{Ref: req.Ref, Name: p.name, Version: p.version, Phase: InstallDone, Message: msg})
	return res, nil
}

func (m *Manager) install(ctx context.Context, req InstallRequest, p plan) (InstallResult, error) {
	res := InstallResult{Kind: p.kind, Source: p.source, Version: p.version, Warnings: p.warnings}
	origin := originOf(p.kind, p.source)
	// Before downloading: a package from another source does not inherit the name's
	// consent, secrets and data without --force (origin.go). claimLocked checks again.
	if _, err := m.checkOrigin(ctx, p.name, origin, req.Force); err != nil {
		return InstallResult{}, err
	}
	link := filepath.Join(m.opts.Dir, p.name)
	fi, lerr := os.Lstat(link)
	isLink := lerr == nil && fi.Mode()&fs.ModeSymlink != 0
	if isLink && !req.Force {
		target, _ := os.Readlink(link)
		return InstallResult{}, fmt.Errorf("%w: plugin %s is a dev link to %s; --force replaces it with the %s package", ErrFailedPrecondition, p.name, target, p.version)
	}
	if cur, ok := m.Snapshot().Plugin(p.name); ok && !isLink {
		res.Previous = cur.Manifest.Version
		if cur.Manifest.Version == p.version && !req.Force {
			return m.finishInstall(ctx, req, res, p.name)
		}
	}
	staging, err := m.stagingRoot()
	if err != nil {
		return InstallResult{}, err
	}
	work, err := os.MkdirTemp(staging, p.name+"-")
	if err != nil {
		return InstallResult{}, fmt.Errorf("plugin: staging: %w", err)
	}
	defer func() { _ = os.RemoveAll(work) }()
	tarball := filepath.Join(work, registry.TarballName(p.name, p.version, registry.Platform()))
	ev := InstallProgress{Ref: req.Ref, Name: p.name, Version: p.version}
	step := func(ph InstallPhase, msg string) {
		ev.Phase, ev.Message, ev.Bytes = ph, msg, 0
		m.progress(ev)
	}
	step(InstallDownloading, "downloading "+p.artifact.URL)
	var last time.Time
	err = m.opts.Registry.Fetcher().Download(ctx, p.artifact.URL, tarball, func(n int64) {
		if now := time.Now(); now.Sub(last) >= 250*time.Millisecond {
			last, ev.Bytes = now, n
			m.progress(ev)
		}
	})
	if err != nil {
		return InstallResult{}, registryError(err)
	}
	if p.artifact.SHA256 != "" {
		step(InstallVerifying, "checking the SHA-256")
		if err := registry.Verify(tarball, p.artifact.SHA256); err != nil {
			return InstallResult{}, fmt.Errorf("%w: %s %s: %v", ErrFailedPrecondition, p.name, p.version, err)
		}
	}
	sum, _ := registry.SHA256File(tarball)
	step(InstallExtracting, "unpacking")
	pkg := filepath.Join(work, "pkg")
	if err := os.Mkdir(pkg, 0o755); err != nil {
		return InstallResult{}, fmt.Errorf("plugin: staging: %w", err)
	}
	if err := registry.Extract(tarball, pkg); err != nil {
		return InstallResult{}, fmt.Errorf("%w: %s %s: %v", ErrFailedPrecondition, p.name, p.version, err)
	}
	warnings, err := checkPackage(pkg, p)
	if err != nil {
		return InstallResult{}, fmt.Errorf("%w: %s %s is not a valid package: %v", ErrFailedPrecondition, p.name, p.version, err)
	}
	res.Warnings = append(res.Warnings, warnings...)
	step(InstallSwapping, "installing into "+link)

	m.opMu.Lock()
	defer m.opMu.Unlock()
	if m.isClosed() {
		return InstallResult{}, ErrClosed
	}
	took, err := m.claimLocked(ctx, p.name, origin, req.Force)
	if err != nil {
		return InstallResult{}, err
	}
	if took != nil {
		res.Warnings = append(res.Warnings, fmt.Sprintf("replaced plugin %s from %s: %s", p.name, originWords(took.from), took.done()))
		res.RemovedThreads = took.removed
	}
	if err := swapPackage(pkg, link, filepath.Join(work, "old")); err != nil {
		return InstallResult{}, err
	}
	rows, err := loadRows(ctx, m.opts.DB)
	if err != nil {
		return InstallResult{}, err
	}
	r := rows[p.name]
	r.Name = p.name
	if r.DevPath != "" {
		r.DevPath = ""
		if err := saveRow(ctx, m.opts.DB, r, m.opts.Now()); err != nil {
			return InstallResult{}, err
		}
	}
	rec := InstallRecord{Kind: p.kind, Source: p.source, Version: p.version, InstalledAt: m.opts.Now().Truncate(time.Millisecond)}
	if p.artifact.SHA256 != "" {
		rec.SHA256 = sum
	}
	if err := saveInstallRow(ctx, m.opts.DB, p.name, rec); err != nil {
		return InstallResult{}, err
	}
	m.inst.setRecord(p.name, &rec)
	pkgs, err := m.discover()
	if err != nil {
		return InstallResult{}, err
	}
	m.apply(ctx, p.name, pkgs[p.name], r, true)
	if e, ok := m.entry(p.name); ok {
		from := p.source
		if res.Previous != "" {
			e.logs.add("host", "", fmt.Sprintf("updated %s → %s from %s", res.Previous, p.version, from))
		} else {
			e.logs.add("host", "", fmt.Sprintf("installed %s from %s", p.version, from))
		}
	}
	res.Changed = true
	if took != nil {
		// A takeover is never enabled on the install's consent: enabling shows the
		// permissions again.
		req.Consent = false
	}
	return m.finishLocked(ctx, req, res, p.name)
}

// finishInstall enables when asked (taking opMu) and fills the result's plugin.
func (m *Manager) finishInstall(ctx context.Context, req InstallRequest, res InstallResult, name string) (InstallResult, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	return m.finishLocked(ctx, req, res, name)
}

// finishLocked: opMu held.
func (m *Manager) finishLocked(ctx context.Context, req InstallRequest, res InstallResult, name string) (InstallResult, error) {
	if req.Enable {
		er, err := m.enableLocked(ctx, name, req.Consent)
		if err != nil {
			return InstallResult{}, err
		}
		res.NeedsConsent, res.Consent = er.NeedsConsent, er.Consent
	}
	res.Plugin = m.public(name)
	return res, nil
}

// checkPackage validates an unpacked package against its plan: the manifest (the SDK's
// validator), its name and version, the protocol, exec, and permissions within the
// registry entry's.
func checkPackage(dir string, p plan) ([]string, error) {
	mf, warnings, err := readManifest(dir)
	if err != nil {
		return nil, err
	}
	switch {
	case mf.Name != p.name:
		return nil, fmt.Errorf("plugin.json names %q, not %q", mf.Name, p.name)
	case mf.Version != p.version:
		return nil, fmt.Errorf("plugin.json says version %s, not %s", mf.Version, p.version)
	case mf.Protocol != pluginsdk.ProtocolVersion:
		return nil, fmt.Errorf("it speaks protocol %d, this Code Foundry speaks %d", mf.Protocol, pluginsdk.ProtocolVersion)
	case p.perms != nil && !mf.Permissions.Within(*p.perms):
		return nil, fmt.Errorf("plugin.json asks for permissions its registry entry does not list (%s)", describe(mf.Permissions))
	}
	real, err := filepath.EvalSymlinks(dir) // resolveExec compares resolved paths
	if err != nil {
		return nil, err
	}
	if _, err := resolveExec(real, mf.Exec); err != nil {
		return nil, err
	}
	for i, w := range warnings {
		warnings[i] = "plugin.json: " + w
	}
	return warnings, nil
}

// swapPackage puts the staged package at target: a missing target is a rename; a dev
// link is removed first; an installed package moves to trash (deleted by the caller's
// cleanup) and comes back if the second rename fails.
func swapPackage(staged, target, trash string) error {
	fi, err := os.Lstat(target)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return fmt.Errorf("plugin: install: %w", err)
	case fi.Mode()&fs.ModeSymlink != 0:
		if err := os.Remove(target); err != nil {
			return fmt.Errorf("plugin: install: remove the dev link: %w", err)
		}
	default:
		if err := os.Rename(target, trash); err != nil {
			return fmt.Errorf("plugin: install: move the old package aside: %w", err)
		}
		if err := os.Rename(staged, target); err != nil {
			_ = os.Rename(trash, target)
			return fmt.Errorf("plugin: install: %w", err)
		}
		return nil
	}
	if err := os.Rename(staged, target); err != nil {
		return fmt.Errorf("plugin: install: %w", err)
	}
	return nil
}

// installLink is `plugin install <folder>`: Dev's link, without enabling unless asked.
func (m *Manager) installLink(ctx context.Context, dir string, req InstallRequest) (InstallResult, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if m.isClosed() {
		return InstallResult{}, ErrClosed
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return InstallResult{}, fmt.Errorf("%w: %v", ErrInvalidArgument, err)
	}
	if m.opts.Home != "" && !fsx.Within(m.opts.Home, real) {
		return InstallResult{}, fmt.Errorf("%w: %s is outside your home directory", ErrInvalidArgument, real)
	}
	if err := m.refuseInsidePlugins(real); err != nil {
		return InstallResult{}, err
	}
	mf, warnings, err := readManifest(real)
	if err != nil {
		return InstallResult{}, fmt.Errorf("%w: %s: %v", ErrInvalidArgument, real, err)
	}
	name := mf.Name
	link := filepath.Join(m.opts.Dir, name)
	res := InstallResult{Kind: KindPath, Source: real, Version: mf.Version, Warnings: warnings, Changed: true}
	if fi, err := os.Lstat(link); err == nil && fi.Mode()&fs.ModeSymlink == 0 && !req.Force {
		return InstallResult{}, fmt.Errorf("%w: plugin %s is installed at %s; --force replaces it with a link to %s", ErrFailedPrecondition, name, link, real)
	}
	took, err := m.claimLocked(ctx, name, originOf(KindPath, real), req.Force)
	if err != nil {
		return InstallResult{}, err
	}
	if took != nil {
		res.Warnings = append(res.Warnings, fmt.Sprintf("replaced plugin %s from %s: %s", name, originWords(took.from), took.done()))
		res.RemovedThreads = took.removed
		req.Consent = false
	}
	if cur, ok := m.Snapshot().Plugin(name); ok {
		res.Previous = cur.Manifest.Version
	}
	if err := m.linkOverPackage(name, real, link); err != nil {
		return InstallResult{}, err
	}
	rows, err := loadRows(ctx, m.opts.DB)
	if err != nil {
		return InstallResult{}, err
	}
	r := rows[name]
	r.Name, r.DevPath = name, real
	if err := saveRow(ctx, m.opts.DB, r, m.opts.Now()); err != nil {
		return InstallResult{}, err
	}
	rec := InstallRecord{Kind: KindPath, Source: real, Version: mf.Version, InstalledAt: m.opts.Now().Truncate(time.Millisecond)}
	if err := saveInstallRow(ctx, m.opts.DB, name, rec); err != nil {
		return InstallResult{}, err
	}
	m.inst.setRecord(name, &rec)
	if err := m.reloadLocked(ctx); err != nil {
		return InstallResult{}, err
	}
	if e, ok := m.entry(name); ok {
		e.logs.add("host", "", "linked "+real+" as a dev plugin")
	}
	m.progress(InstallProgress{Ref: req.Ref, Name: name, Version: mf.Version, Phase: InstallDone, Message: "linked " + real})
	return m.finishLocked(ctx, req, res, name)
}

// refuseInsidePlugins refuses a dev link to a folder inside the plugins directory: a
// package there already runs as installed, and linking its own name over it would move
// the folder aside, delete it, and leave a link to nothing.
func (m *Manager) refuseInsidePlugins(real string) error {
	dir := filepath.Clean(m.opts.Dir)
	if r, err := filepath.EvalSymlinks(dir); err == nil {
		dir = r
	}
	if !fsx.Within(dir, real) {
		return nil
	}
	rel, err := filepath.Rel(dir, real)
	if err != nil || rel == "." {
		return fmt.Errorf("%w: %s is the plugins folder; point at a plugin's own folder outside it", ErrInvalidArgument, real)
	}
	pkg, _, _ := strings.Cut(rel, string(filepath.Separator))
	return fmt.Errorf("%w: %s is inside the plugins folder, so it already runs as the installed package %s (code-foundry plugin restart %s picks up a rebuild); to develop it as a dev plugin, move it out of %s first",
		ErrFailedPrecondition, real, pkg, pkg, dir)
}

// linkOverPackage points link at real; an installed package there (a directory, not a
// link) is moved aside and removed first. Callers have checked --force.
func (m *Manager) linkOverPackage(name, real, link string) error {
	if fi, err := os.Lstat(link); err == nil && fi.Mode()&fs.ModeSymlink == 0 {
		staging, err := m.stagingRoot()
		if err != nil {
			return err
		}
		trash, err := os.MkdirTemp(staging, name+"-removed-")
		if err != nil {
			return fmt.Errorf("plugin: staging: %w", err)
		}
		defer func() { _ = os.RemoveAll(trash) }()
		if err := os.Rename(link, filepath.Join(trash, "pkg")); err != nil {
			return fmt.Errorf("plugin: install: move the package aside: %w", err)
		}
	}
	return linkDir(real, link)
}

// Uninstall disables a plugin, stops it, removes its threads (the thread store's Remove,
// as thread.remove) and its package (a dev link is removed, never the folder it points
// at). purge also deletes its data dir, its secrets (the
// Keychain items and their names), its logs, and the user's choices about it (enabled,
// consent); without purge those stay, so a reinstall picks up where it left off (still
// disabled).
func (m *Manager) Uninstall(ctx context.Context, name string, purge bool) (UninstallResult, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if m.isClosed() {
		return UninstallResult{}, ErrClosed
	}
	if !registry.ValidName(name) {
		return UninstallResult{}, fmt.Errorf("%w: %q is not a plugin name", ErrInvalidArgument, name)
	}
	e, ok := m.entry(name)
	rows, err := loadRows(ctx, m.opts.DB)
	if err != nil {
		return UninstallResult{}, err
	}
	r, hasRow := rows[name]
	_, hasRec := m.inst.record(name)
	dataDir := filepath.Join(m.opts.DataDir, name)
	_, dataErr := os.Stat(dataDir)
	secrets, err := listSecrets(ctx, m.opts.DB, name)
	if err != nil {
		return UninstallResult{}, err
	}
	leftovers := hasRow || hasRec || dataErr == nil || len(secrets) > 0
	if !ok && !(purge && leftovers) {
		return UninstallResult{}, fmt.Errorf("%w: no plugin %q in %s", ErrNotFound, name, m.opts.Dir)
	}
	var res UninstallResult
	if hasRow && (r.Enabled || r.DevPath != "") {
		r.Enabled, r.DevPath = false, ""
		if err := saveRow(ctx, m.opts.DB, r, m.opts.Now()); err != nil {
			return UninstallResult{}, err
		}
	}
	var logs *logBuffer
	if ok {
		logs = e.logs
		m.update(name, nil, func(e *entry) { e.row, e.disabledReason = r, "" })
		m.stopActor(e, StateDisabled)
		m.unregister(name)
	}
	res.RemovedThreads = m.discard(ctx, name, logs, "the plugin was uninstalled")
	link := filepath.Join(m.opts.Dir, name)
	if fi, err := os.Lstat(link); err == nil {
		if fi.Mode()&fs.ModeSymlink != 0 {
			if err := os.Remove(link); err != nil {
				return UninstallResult{}, fmt.Errorf("plugin: uninstall: %w", err)
			}
		} else {
			staging, err := m.stagingRoot()
			if err != nil {
				return UninstallResult{}, err
			}
			trash, err := os.MkdirTemp(staging, name+"-removed-")
			if err != nil {
				return UninstallResult{}, fmt.Errorf("plugin: uninstall: %w", err)
			}
			err = os.Rename(link, filepath.Join(trash, "pkg"))
			if err == nil {
				err = os.RemoveAll(trash)
			}
			if err != nil {
				return UninstallResult{}, fmt.Errorf("plugin: uninstall: %w", err)
			}
		}
		res.Removed = link
	}
	if err := deleteInstallRow(ctx, m.opts.DB, name); err != nil {
		return UninstallResult{}, err
	}
	m.inst.setRecord(name, nil)
	if err := m.reloadLocked(ctx); err != nil {
		return UninstallResult{}, err
	}
	if !purge {
		return res, nil
	}
	purged, err := m.purgeSecretsAndData(ctx, name)
	res.Purged = append(res.Purged, purged...)
	if err != nil {
		return res, err
	}
	for _, f := range []string{name + ".log", name + ".log.1"} {
		_ = os.Remove(filepath.Join(m.opts.LogDir, f))
	}
	res.Purged = append(res.Purged, "its logs")
	if hasRow {
		if err := deletePluginRow(ctx, m.opts.DB, name); err != nil {
			return res, err
		}
		res.Purged = append(res.Purged, "its consent and settings")
	}
	return res, nil
}
