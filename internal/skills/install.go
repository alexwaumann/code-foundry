package skills

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Layout of the directory Install owns (paths.Paths.Claude): every thread's claude
// gets it as --add-dir, and Claude Code loads the skills in an added directory's
// .claude/skills.
const (
	// ConfigDir is the directory Install replaces as a whole.
	ConfigDir = ".claude"
	// SkillsDir is where the skills are, relative to the owned directory.
	SkillsDir = ConfigDir + "/skills"
	// VersionFile holds the version of the daemon that wrote the skills.
	VersionFile = "VERSION"
)

// Install writes files under dir/.claude/skills and version to dir/VERSION, replacing
// whatever an earlier start wrote. The new .claude is written in full beside the old one
// first, then swapped in by rename, so a claude starting meanwhile sees the old skills
// or the new ones, never a half-written file (between the two renames, briefly, none).
// Everything else in dir is removed: files of an older layout and leftovers of an
// interrupted Install. dir itself is created when missing and never removed (claude
// refuses a missing --add-dir).
func Install(dir, version string, files Files) error {
	if dir == "" {
		return errors.New("skills: empty directory")
	}
	for p := range files {
		if err := checkPath(p); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("skills: create %s: %w", dir, err)
	}
	staged, err := os.MkdirTemp(dir, ".new-")
	if err != nil {
		return fmt.Errorf("skills: stage: %w", err)
	}
	defer func() { _ = os.RemoveAll(staged) }() // a no-op once renamed into place
	for p, b := range files {
		dst := filepath.Join(staged, filepath.FromSlash(path.Join("skills", p)))
		// Ordinary modes inside the private .claude (MkdirTemp makes it 0700): the plugin
		// skill's example is copied out as a new repository's files.
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return fmt.Errorf("skills: %w", err)
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			return fmt.Errorf("skills: %w", err)
		}
	}
	live := filepath.Join(dir, ConfigDir)
	old := staged + "-old"
	switch err := os.Rename(live, old); {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return fmt.Errorf("skills: move the old skills aside: %w", err)
	}
	if err := os.Rename(staged, live); err != nil {
		_ = os.Rename(old, live) // put the old ones back
		return fmt.Errorf("skills: install: %w", err)
	}
	if err := writeAtomic(filepath.Join(dir, VersionFile), []byte(version+"\n")); err != nil {
		return err
	}
	return prune(dir)
}

// prune removes every entry of dir but ConfigDir and VersionFile.
func prune(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("skills: %w", err)
	}
	var errs []error
	for _, e := range entries {
		if n := e.Name(); n != ConfigDir && n != VersionFile {
			if err := os.RemoveAll(filepath.Join(dir, n)); err != nil {
				errs = append(errs, err)
			}
		}
	}
	if err := errors.Join(errs...); err != nil {
		return fmt.Errorf("skills: remove stale files: %w", err)
	}
	return nil
}

// writeAtomic writes b to name through a temporary file in the same directory.
func writeAtomic(name string, b []byte) error {
	f, err := os.CreateTemp(filepath.Dir(name), "."+filepath.Base(name)+".new-")
	if err != nil {
		return fmt.Errorf("skills: %w", err)
	}
	_, werr := f.Write(b)
	cerr := f.Close()
	if err := errors.Join(werr, cerr); err != nil {
		_ = os.Remove(f.Name())
		return fmt.Errorf("skills: write %s: %w", name, err)
	}
	if err := os.Rename(f.Name(), name); err != nil {
		_ = os.Remove(f.Name())
		return fmt.Errorf("skills: write %s: %w", name, err)
	}
	return nil
}

// checkPath refuses a file path that is not a clean relative path inside a skill.
func checkPath(p string) error {
	if p == "" || path.IsAbs(p) || path.Clean(p) != p || p == ".." || strings.HasPrefix(p, "../") || !strings.Contains(p, "/") {
		return fmt.Errorf("skills: bad file path %q (want <skill>/<file>)", p)
	}
	return nil
}
