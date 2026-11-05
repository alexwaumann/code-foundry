package preview

import (
	"os"
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

// homeMarkers are the files that make a directory a Code Foundry config home wherever it
// is: a running daemon's token, and the pages port a daemon keeps after it stops.
var homeMarkers = []string{filepath.Base(paths.New("").Token()), filepath.Base(paths.New("").PagesPort())}

// Floor is what a grant may never reach: every Code Foundry config home it can know (the
// daemon token, database, logs) outside the folders Code Foundry keeps checkouts and pages
// in, and the credential folders under home. A grant's tree may also never be home itself
// or contain any of those, so a page previewed from ~/report.html cannot read
// ~/.code-foundry/daemon.token, and a page served by a test daemon cannot read the real
// daemon's (docs/notes/preview-scope-floor.md).
//
// The homes known up front are the current config home and the default one
// (~/.code-foundry). Any other, another daemon's CODE_FOUNDRY_HOME, is found by its
// markers (homeMarkers): Guarded stats them in p's ancestors, and ScopeOK also in the
// tree's direct children, every time it is asked.
type Floor struct {
	home  string
	homes []string // config homes known up front
	creds []string // trees no grant may read
}

// NewFloor returns the floor for home (resolved, fsx.HomeRoot) and the config home p.
func NewFloor(home string, p paths.Paths) Floor {
	f := Floor{home: home, homes: []string{realPath(p.Home())}}
	if def := realPath(filepath.Join(home, paths.DirName)); def != f.homes[0] {
		f.homes = append(f.homes, def)
	}
	for _, c := range credentialPaths {
		f.creds = append(f.creds, filepath.Join(home, c))
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

// checkouts are a config home's trees of the user's own work, the ones a write may reach.
func checkouts(h paths.Paths) []string { return []string{h.Worktrees(), h.Projects()} }

// readable are a config home's trees that may be read: its checkouts and the pages
// threads write to show (paths.Pages).
func readable(h paths.Paths) []string { return append(checkouts(h), h.Pages()) }

// inHome reports whether p lies in the config home root outside its open trees.
func inHome(root, p string, open func(paths.Paths) []string) bool {
	if !fsx.Within(root, p) {
		return false
	}
	for _, o := range open(paths.New(root)) {
		if fsx.Within(o, p) {
			return false
		}
	}
	return true
}

// isHome reports whether dir holds a config home's marker file.
func isHome(dir string) bool {
	for _, m := range homeMarkers {
		if _, err := os.Lstat(filepath.Join(dir, m)); err == nil {
			return true
		}
	}
	return false
}

// Guarded reports whether p (absolute, cleaned) lies in a tree no grant may read. The
// names are compared first, then file identities (guardedByIdentity): APFS folds names
// more than any string comparison here does (~/.ßh is ~/.ssh), so the names are only a
// fast path and the identities decide.
func (f Floor) Guarded(p string) bool {
	return f.guardedByName(p) || f.guardedByIdentity(p)
}

// InConfigHome reports whether p (absolute, cleaned) lies in a config home outside its
// checkouts, the part of the floor that also holds for a write: a user may edit ~/.ssh,
// but the daemon's token and database are not theirs to edit. Pages count as the config
// home here, though a grant may read them. Like Guarded it decides by file identity. A
// hard link to a file in a config home does not count: a write replaces the name it is
// given, and the file behind the link's other names stays as it was.
//
// A checkout is what lies strictly below a tree, so p's directory is asked too: a file
// made at the name projects, which does not exist until first use, would break the
// clones that later want that folder there. A name in a config home's own directory is
// always the config home's.
func (f Floor) InConfigHome(p string) bool {
	return f.inHomeOutsideCheckouts(p) || f.inHomeOutsideCheckouts(filepath.Dir(p))
}

// inHomeOutsideCheckouts reports whether p lies in a config home outside the trees of
// checkouts.
func (f Floor) inHomeOutsideCheckouts(p string) bool {
	return f.inHomeByName(p, checkouts) || below(f.homeGuards(checkouts), realPath(p))
}

// guardedByName is Guarded on the spelling of p.
func (f Floor) guardedByName(p string) bool {
	if f.inHomeByName(p, readable) {
		return true
	}
	for _, c := range f.creds {
		if fsx.Within(c, p) {
			return true
		}
	}
	return false
}

// inHomeByName reports whether p, as spelled, lies in a config home outside its open
// trees.
func (f Floor) inHomeByName(p string, open func(paths.Paths) []string) bool {
	for _, h := range f.homes {
		if inHome(h, p, open) {
			return true
		}
	}
	// Homes nobody named: p itself or an ancestor holding a marker, up to home.
	for d := p; fsx.Within(f.home, d); d = filepath.Dir(d) {
		if isHome(d) && inHome(d, p, open) {
			return true
		}
		if d == filepath.Dir(d) {
			break
		}
	}
	return false
}

// ScopeOK reports whether dir may be a grant's whole tree: strictly below home, not
// guarded, and holding nothing guarded (so not an ancestor of a config home). A home
// deeper than dir's direct children is not looked for; the route still 404s it, since
// Guarded finds it from the served path.
func (f Floor) ScopeOK(dir string) bool {
	if fsx.Within(dir, f.home) || !fsx.Within(f.home, dir) || f.Guarded(dir) {
		return false
	}
	roots := append(f.homes[:len(f.homes):len(f.homes)], f.creds...)
	for _, g := range roots {
		if fsx.Within(dir, g) {
			return false
		}
	}
	// The same by identity: dir, however it is spelled, is no ancestor of home or of a
	// guarded tree.
	if fi, err := os.Stat(dir); err == nil {
		for _, g := range append(roots, f.home) {
			if ancestorOf(fi, g) {
				return false
			}
		}
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if (e.IsDir() || e.Type()&os.ModeSymlink != 0) && isHome(filepath.Join(dir, e.Name())) {
			return false
		}
	}
	return true
}
