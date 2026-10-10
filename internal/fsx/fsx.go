// Package fsx holds the filesystem rules the daemon applies to user-typed paths: the
// home-directory boundary every project path must stay inside, and directory
// completion for the GUI's path prompts (FilesystemService.ListDirectories).
package fsx

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
