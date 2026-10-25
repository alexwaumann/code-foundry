package project

import (
	"cmp"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// Folder inspection for the Add Project dialog's folder-of-repos scan
// (docs/notes/workspaces-v2-6-scan.md): before a folder is added, the dialog asks what
// Register would make of it. A folder that is not a git repository but holds git
// repositories one level down can be added as a rooted workspace of those repositories
// instead of one plain project.

// Folder is what Inspect found at a path.
type Folder struct {
	// Path is the folder, absolute with symlinks resolved.
	Path string
	// IsRepo: Register would add a git repository (the folder is one, or is inside one).
	IsRepo bool
	// ChildRepos are the git repositories directly inside the folder (ChildRepos), set
	// only when IsRepo is false.
	ChildRepos []ChildRepo
}

// ChildRepo is a git repository directly inside an inspected folder.
type ChildRepo struct {
	Path string // absolute, dir/name
	Name string
}

// Inspect implements Store.
func (g *Git) Inspect(ctx context.Context, path string) (Folder, error) {
	if path == "" {
		return Folder{}, fmt.Errorf("%w: path is required", ErrInvalidArgument)
	}
	dir, err := resolveDir(path)
	if err != nil {
		return Folder{}, err
	}
	if !fsx.Within(g.root, dir) {
		return Folder{}, outsideRoot(path)
	}
	// The same answer Register acts on: git's own, not a walk up for .git.
	_, isGit, err := g.projectRoot(ctx, path, dir)
	if err != nil {
		return Folder{}, err
	}
	f := Folder{Path: dir, IsRepo: isGit}
	if isGit {
		return f, nil
	}
	if f.ChildRepos, err = ChildRepos(dir); err != nil {
		return Folder{}, err
	}
	return f, nil
}

// ChildRepos lists the git repositories directly inside dir: its immediate children
// that are directories holding a .git directory or file (a linked worktree or a
// submodule has a file). Hidden children (a leading ".") and symlinks are skipped: a
// link can lead anywhere, and Register would add whatever it resolves to. Sorted by
// name, case-insensitively. An unreadable child is skipped; an unreadable dir is an
// error.
func ChildRepos(dir string) ([]ChildRepo, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %w", ErrInvalidArgument, dir, err)
	}
	var repos []ChildRepo
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") || !e.IsDir() {
			// e.IsDir is false for a symlink, even to a directory.
			continue
		}
		child := filepath.Join(dir, name)
		if !hasDotGit(child) {
			continue
		}
		repos = append(repos, ChildRepo{Path: child, Name: name})
	}
	slices.SortFunc(repos, func(a, b ChildRepo) int {
		return cmp.Or(cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)), cmp.Compare(a.Name, b.Name))
	})
	return repos, nil
}
