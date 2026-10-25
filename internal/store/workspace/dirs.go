package workspace

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

// Managed dirs (docs/notes/workspaces-v2-handoff.md §3). Every workspace has
// <Options.Dir>/<id>/, made when it is created and at every daemon start. A rooted
// workspace's holds symlinks CLAUDE.md, AGENTS.md and .claude to the same names under
// its root, for the ones that exist; ensureDir re-checks them at every spawn: missing
// links are added, dangling ones removed. Nothing is copied.

// LinkNames are the root entries a rooted workspace's managed dir links to.
var LinkNames = []string{"CLAUDE.md", "AGENTS.md", ".claude"}

// managedDirMode is a managed dir's permissions: its CLAUDE.md goes into system prompts.
const managedDirMode = 0o700

// ensureDir makes w's managed dir (its permissions put back to 0700 when they differ)
// and, when w is rooted, its symlinks. A rooted workspace whose root is gone keeps no
// links (they would dangle) until SetRoot points it at the folder again.
func ensureDir(log *slog.Logger, w Workspace) error {
	if w.ManagedDir == "" {
		return nil
	}
	if err := os.MkdirAll(w.ManagedDir, managedDirMode); err != nil {
		return fmt.Errorf("workspace %s: managed dir: %w", w.ID, err)
	}
	if fi, err := os.Stat(w.ManagedDir); err == nil && fi.Mode().Perm() != managedDirMode {
		if err := os.Chmod(w.ManagedDir, managedDirMode); err != nil {
			return fmt.Errorf("workspace %s: managed dir permissions: %w", w.ID, err)
		}
		log.Warn("workspace managed dir permissions restored", "workspace", w.ID, "dir", w.ManagedDir,
			"was", fmt.Sprintf("%#o", fi.Mode().Perm()), "now", fmt.Sprintf("%#o", managedDirMode))
	}
	if w.RootPath == "" {
		return nil
	}
	var errs []error
	for _, name := range LinkNames {
		link, target := filepath.Join(w.ManagedDir, name), filepath.Join(w.RootPath, name)
		_, terr := os.Stat(target)
		fi, lerr := os.Lstat(link)
		switch {
		case lerr == nil && fi.Mode()&os.ModeSymlink != 0:
			cur, _ := os.Readlink(link)
			if terr == nil && cur == target {
				continue
			}
			if err := os.Remove(link); err != nil {
				errs = append(errs, fmt.Errorf("workspace %s: remove link %s: %w", w.ID, link, err))
				continue
			}
			if terr != nil {
				log.Info("workspace link removed: its target is gone", "workspace", w.ID, "link", link, "target", target)
				continue
			}
			fallthrough
		case errors.Is(lerr, os.ErrNotExist) && terr == nil:
			if err := os.Symlink(target, link); err != nil {
				errs = append(errs, fmt.Errorf("workspace %s: link %s: %w", w.ID, link, err))
				continue
			}
			log.Info("workspace link made", "workspace", w.ID, "link", link, "target", target)
		case lerr == nil:
			// A real file or folder where a link would go (made by hand, or by a thread
			// before the root was the place to write): left alone; thread checkouts warns
			// about it (Strays).
			log.Warn("workspace managed dir has a file where a link to the root would go; leaving it", "workspace", w.ID, "path", link)
		}
	}
	return errors.Join(errs...)
}

// Strays are the real files or folders in a rooted workspace's managed dir where a link
// to the root goes (LinkNames that are not symlinks). Claude Code loads the root's own
// files in a thread that runs there, and a spawn reads the root's instructions, so a
// stray is not what the workspace's threads follow. Nil for a synthetic workspace.
func Strays(w Workspace) []string {
	if w.RootPath == "" || w.ManagedDir == "" {
		return nil
	}
	var out []string
	for _, name := range LinkNames {
		p := filepath.Join(w.ManagedDir, name)
		if fi, err := os.Lstat(p); err == nil && fi.Mode()&os.ModeSymlink == 0 {
			out = append(out, p)
		}
	}
	return out
}

// removeDir is Remove's cleanup: a synthetic workspace's managed dir goes with its
// instructions and skills; a rooted one's loses its symlinks (then the dir, when empty).
// A managed dir outside root (never one the store made) is left alone.
func removeDir(log *slog.Logger, root string, w Workspace) error {
	if w.ManagedDir == "" || root == "" || filepath.Dir(filepath.Clean(w.ManagedDir)) != filepath.Clean(root) {
		return nil
	}
	if w.RootPath == "" {
		if err := os.RemoveAll(w.ManagedDir); err != nil {
			return fmt.Errorf("workspace %s: remove managed dir: %w", w.ID, err)
		}
		log.Info("workspace managed dir removed", "workspace", w.ID, "dir", w.ManagedDir)
		return nil
	}
	for _, name := range LinkNames {
		link := filepath.Join(w.ManagedDir, name)
		if fi, err := os.Lstat(link); err == nil && fi.Mode()&os.ModeSymlink != 0 {
			if err := os.Remove(link); err != nil {
				return fmt.Errorf("workspace %s: remove link %s: %w", w.ID, link, err)
			}
		}
	}
	if err := os.Remove(w.ManagedDir); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Info("rooted workspace's managed dir kept: it holds more than the links", "workspace", w.ID, "dir", w.ManagedDir)
	}
	return nil
}
