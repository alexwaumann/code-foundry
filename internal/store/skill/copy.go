package skill

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// Copying a skill out of a marketplace checkout: staged beside the target, then renamed
// into place, so Claude Code never reads a half-copied skill.

// copyTree copies the directory src into dst, which must exist: directories and regular
// files only (a symlink, socket or device in the checkout is skipped, never followed),
// directories 0755, files 0755 when the source has an execute bit and 0644 otherwise.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		target := filepath.Join(dst, rel)
		switch {
		case d.IsDir():
			return os.Mkdir(target, 0o755)
		case d.Type().IsRegular():
			info, err := d.Info()
			if err != nil {
				return err
			}
			mode := os.FileMode(0o644)
			if info.Mode().Perm()&0o111 != 0 {
				mode = 0o755
			}
			return copyFile(p, target, mode)
		}
		return nil // a symlink or something stranger: not copied
	})
}

func copyFile(src, dst string, mode os.FileMode) (err error) {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := out.Close(); err == nil {
			err = cerr
		}
	}()
	_, err = io.Copy(out, in)
	return err
}

// installDir copies src into target (a skill directory, in the skills or the disabled
// dir): it copies into a hidden staging directory beside target, then renames it into
// place. An existing target is replaced: moved aside, the copy renamed in, the old one
// deleted (and put back if the rename fails).
func installDir(src, target string) error {
	fi, err := os.Lstat(src)
	if err != nil {
		return fmt.Errorf("read %s: %w", src, err)
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a directory", src)
	}
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", parent, err)
	}
	stage, err := os.MkdirTemp(parent, ".cf-stage-"+filepath.Base(target)+"-")
	if err != nil {
		return fmt.Errorf("stage %s: %w", target, err)
	}
	if err := os.Chmod(stage, 0o755); err != nil {
		_ = os.RemoveAll(stage)
		return fmt.Errorf("stage %s: %w", target, err)
	}
	if err := copyTree(src, stage); err != nil {
		_ = os.RemoveAll(stage)
		return fmt.Errorf("copy %s: %w", src, err)
	}
	var old string
	if _, err := os.Lstat(target); err == nil {
		old = filepath.Join(parent, ".cf-old-"+filepath.Base(target)+"-"+randomSuffix())
		if err := os.Rename(target, old); err != nil {
			_ = os.RemoveAll(stage)
			return fmt.Errorf("replace %s: %w", target, err)
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		_ = os.RemoveAll(stage)
		return fmt.Errorf("replace %s: %w", target, err)
	}
	if err := os.Rename(stage, target); err != nil {
		_ = os.RemoveAll(stage)
		if old != "" {
			_ = os.Rename(old, target)
		}
		return fmt.Errorf("install %s: %w", target, err)
	}
	if old != "" {
		if err := os.RemoveAll(old); err != nil {
			return fmt.Errorf("delete the replaced %s: %w", old, err)
		}
	}
	return nil
}

// moveDir moves the skill directory from to to (enable, disable). to must not exist.
func moveDir(from, to string) error {
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(to), err)
	}
	if _, err := os.Lstat(to); err == nil {
		return fmt.Errorf("%s exists already", to)
	}
	if err := os.Rename(from, to); err != nil {
		return fmt.Errorf("move %s to %s: %w", from, to, err)
	}
	return nil
}

func randomSuffix() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// exists reports whether p exists (a symlink counts, whatever it points at).
func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}
