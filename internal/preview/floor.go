package preview

import (
	"path/filepath"

	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/paths"
)

// credentialPaths are the entries under home that hold keys, tokens or the user's
// private app data. No grant may serve them, whatever its scope.
var credentialPaths = []string{
	".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config", ".claude", ".claude.json",
	".netrc", ".git-credentials", ".npmrc", ".pypirc", "Library",
}

// Floor is what a grant may never reach: the config home (daemon token, database, logs)
// outside the folders Code Foundry keeps checkouts in, and the credential folders under
// home. A grant's tree may also never be home itself or contain any of those, so a page
// previewed from ~/report.html cannot read ~/.code-foundry/daemon.token
// (docs/notes/preview-scope-floor.md).
type Floor struct {
	home    string
	guarded []string // trees no grant may read
	open    []string // trees inside a guarded one that may be read (the config home's checkouts)
}

// NewFloor returns the floor for home (resolved, fsx.HomeRoot) and the config home p.
func NewFloor(home string, p paths.Paths) Floor {
	cfg := realPath(p.Home())
	f := Floor{
		home:    home,
		guarded: []string{cfg},
		// The checkouts, and the pages threads write to show (paths.Pages).
		open: []string{filepath.Join(cfg, filepath.Base(p.Worktrees())), filepath.Join(cfg, filepath.Base(p.Projects())), filepath.Join(cfg, filepath.Base(p.Pages()))},
	}
	for _, c := range credentialPaths {
		f.guarded = append(f.guarded, filepath.Join(home, c))
	}
	return f
}

// realPath is p with its symlinks resolved (/tmp is /private/tmp), or p cleaned when it
// does not exist yet.
func realPath(p string) string {
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return real
	}
	return filepath.Clean(p)
}

// Home is the home directory no grant reaches outside of.
func (f Floor) Home() string { return f.home }

// Guarded reports whether p (absolute, cleaned) lies in a tree no grant may read.
func (f Floor) Guarded(p string) bool {
	for _, o := range f.open {
		if fsx.Within(o, p) {
			return false
		}
	}
	for _, g := range f.guarded {
		if fsx.Within(g, p) {
			return true
		}
	}
	return false
}

// ScopeOK reports whether dir may be a grant's whole tree: strictly below home, not
// guarded, and holding nothing guarded (so not an ancestor of the config home).
func (f Floor) ScopeOK(dir string) bool {
	if fsx.Within(dir, f.home) || !fsx.Within(f.home, dir) || f.Guarded(dir) {
		return false
	}
	for _, g := range f.guarded {
		if fsx.Within(dir, g) {
			return false
		}
	}
	return true
}
