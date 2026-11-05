// Package fsx holds the filesystem rules the daemon applies to user-typed paths: the
// home-directory boundary every project path must stay inside, directory completion for
// the GUI's path prompts (FilesystemService.ListDirectories), and the file viewer's reads
// and writes.
package fsx

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// ErrInvalidArgument marks a prefix that cannot be completed: relative, "~user", or
// outside the allowed root.
var ErrInvalidArgument = errors.New("invalid argument")

// HomeRoot returns the user's home directory with symlinks resolved, the default
// allowed root.
func HomeRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("fsx: home directory: %w", err)
	}
	return ResolveRoot(home)
}

// ResolveRoot makes root absolute and resolves its symlinks, so Within can compare it
// with resolved paths (on macOS /tmp and /var are symlinks).
func ResolveRoot(root string) (string, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("fsx: root %s: %w", root, err)
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("fsx: root %s: %w", root, err)
	}
	return real, nil
}

// TempRoots returns the system's temp folders, /tmp and os.TempDir(), each as spelled and
// with its symlinks resolved, without repeats. Both forms are kept because a file that does
// not exist yet has no resolved path to compare, and on macOS both are symlinks (/tmp to
// /private/tmp, $TMPDIR through /var to /private/var). A folder that holds home, "/" for one
// (a TMPDIR set by hand), is no temp folder and is left out: home is what home's rules are for.
func TempRoots(home string) []string {
	var out []string
	for _, dir := range []string{"/tmp", os.TempDir()} {
		forms := []string{filepath.Clean(dir)}
		if !filepath.IsAbs(forms[0]) {
			continue
		}
		if real, err := filepath.EvalSymlinks(forms[0]); err == nil {
			forms = append(forms, real)
		}
		if slices.ContainsFunc(forms, func(f string) bool { return Within(f, home) }) {
			continue
		}
		for _, f := range forms {
			if !slices.Contains(out, f) {
				out = append(out, f)
			}
		}
	}
	return out
}

// Within reports whether path is root or below it. Both must be clean absolute paths
// (resolve symlinks first). The comparison ignores case, like APFS does, so a path
// typed as /users/me/x is inside /Users/me.
func Within(root, path string) bool {
	if root == "/" {
		return strings.HasPrefix(path, "/")
	}
	if len(path) < len(root) || !strings.EqualFold(path[:len(root)], root) {
		return false
	}
	return len(path) == len(root) || path[len(root)] == '/'
}
