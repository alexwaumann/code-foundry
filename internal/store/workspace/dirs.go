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

// ensureDir makes w's managed dir and, when w is rooted, its symlinks.
func ensureDir(log *slog.Logger, w Workspace) error {
	if w.ManagedDir == "" {
		return nil
	}
	if err := os.MkdirAll(w.ManagedDir, 0o700); err != nil {
		return fmt.Errorf("workspace %s: managed dir: %w", w.ID, err)
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
			// A real file or folder where a link would go (made by hand): left alone.
			log.Warn("workspace managed dir has a file where a link to the root would go; leaving it", "workspace", w.ID, "path", link)
		}
	}
	return errors.Join(errs...)
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
