package preview

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

// A path's spelling is not its identity. APFS compares names case- and
// normalization-insensitively with full folding, so ~/.ßh and ~/.ſsh open ~/.ssh,
// ~/.conﬁg opens ~/.config, and a home named cf-test is also cf-teſt, while every string
// comparison here (fsx.Within's case folding included) sees different names. The floor
// therefore decides by file identity (device and inode, os.SameFile): a path is guarded
// when it, or a directory above it, is the same file as a guarded root
// (docs/notes/bridge-fix-floor.md).

// guard is a guarded root, stat'd when asked, and the children of it that stay readable
// (a config home's worktrees, projects and pages).
type guard struct {
	fi       fs.FileInfo
	path     string
	open     []fs.FileInfo
	openName []string
}

// guards stats the floor's roots: the known config homes (with their open children) and
// the credential paths under home. A root that does not exist guards nothing yet; they
// are stat'd on every call, since ~/.claude.json is replaced on every write and a home or
// ~/.aws may appear at any time.
func (f Floor) guards() []guard {
	var out []guard
	for _, h := range f.homes {
		fi, err := os.Stat(h)
		if err != nil {
			continue
		}
		g := guard{fi: fi, path: h}
		hp := paths.New(h)
		for _, o := range []string{hp.Worktrees(), hp.Projects(), hp.Pages()} {
			g.openName = append(g.openName, filepath.Base(o))
			if ofi, err := os.Stat(o); err == nil {
				g.open = append(g.open, ofi)
			}
		}
		out = append(out, g)
	}
	for _, c := range f.creds {
		if fi, err := os.Stat(c); err == nil {
			out = append(out, guard{fi: fi, path: c})
		}
	}
	return out
}

// opens reports whether child is one of g's readable children.
func (g guard) opens(child fs.FileInfo) bool {
	for _, o := range g.open {
		if os.SameFile(o, child) {
			return true
		}
	}
	return false
}

// opensChild is opens for the child of g on a path: by identity, or by name when the
// child does not exist (nothing below it can be served, but a grant may name a pages
// folder before its first page is written).
func (g guard) opensChild(child fs.FileInfo, name string) bool {
	if child != nil {
		return g.opens(child)
	}
	for _, n := range g.openName {
		if strings.EqualFold(n, name) {
			return true
		}
	}
	return false
}

// guardedByIdentity reports whether p, its symlinks resolved, is a guarded root or lies
// below one (each ancestor stat'd and compared), or is a hard link to a guarded file.
func (f Floor) guardedByIdentity(p string) bool {
	gs := f.guards()
	if len(gs) == 0 {
		return false
	}
	real := realPath(p)
	var child fs.FileInfo
	childName := ""
	for d := real; ; d = filepath.Dir(d) {
		fi, err := os.Stat(d)
		if err == nil {
			for _, g := range gs {
				if os.SameFile(fi, g.fi) && !g.opensChild(child, childName) {
					return true
				}
			}
		}
		child, childName = fi, filepath.Base(d)
		if d == filepath.Dir(d) {
			break
		}
	}
	fi, err := os.Stat(real)
	return err == nil && fi.Mode().IsRegular() && links(fi) > 1 && f.hardLinkToGuarded(gs, fi)
}

// links is fi's hard link count; 1 when the platform does not say.
func links(fi fs.FileInfo) uint64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Nlink)
	}
	return 1
}

// Bounds of the hard-link scan: how deep under each guarded root, and how many entries in
// all, so a huge ~/.config cannot stall a request.
const (
	hardLinkDepth   = 2
	hardLinkEntries = 4096
)

// hardLinkToGuarded reports whether fi (a regular file with more than one link) is the
// same file as one in a guarded root: a guarded file itself (~/.claude.json, ~/.netrc), or
// a regular file up to hardLinkDepth below a guarded directory, a config home's open
// children and ~/Library skipped. A hard link has no path back to its other names, so
// the guarded files are listed and compared; only files with more than one link pay for it.
func (f Floor) hardLinkToGuarded(gs []guard, fi fs.FileInfo) bool {
	library := filepath.Join(f.home, "Library")
	budget := hardLinkEntries
	var scan func(dir string, g guard, depth int) bool
	scan = func(dir string, g guard, depth int) bool {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return false
		}
		for _, e := range entries {
			if budget--; budget < 0 {
				return false
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			switch {
			case info.Mode().IsRegular():
				if os.SameFile(info, fi) {
					return true
				}
			case info.IsDir() && depth < hardLinkDepth && !g.opens(info):
				if scan(filepath.Join(dir, e.Name()), g, depth+1) {
					return true
				}
			}
		}
		return false
	}
	for _, g := range gs {
		switch {
		case g.fi.Mode().IsRegular():
			if os.SameFile(g.fi, fi) {
				return true
			}
		case g.fi.IsDir() && g.path != library:
			if scan(g.path, g, 1) {
				return true
			}
		}
	}
	return false
}

// ancestorOf reports whether dir (stat'd) is target or a directory above it, by identity.
func ancestorOf(dir fs.FileInfo, target string) bool {
	for d := target; ; d = filepath.Dir(d) {
		if fi, err := os.Stat(d); err == nil && os.SameFile(fi, dir) {
			return true
		}
		if d == filepath.Dir(d) {
			return false
		}
	}
}
