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
	// only when IsRepo is false and the folder may be a workspace's root: not the home
	// directory (Options.AllowedRoot) itself, nor a registered project's checkout or
	// worktree or inside one (the workspace store refuses those roots).
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
	if isGit || !g.mayBeRoot(dir) {
		return f, nil // added as a plain folder, if at all
	}
	if f.ChildRepos, err = ChildRepos(dir); err != nil {
		return Folder{}, err
	}
	return f, nil
}

// mayBeRoot reports whether dir may be a workspace's root (the workspace store's rule):
// not the allowed root (home) itself, and not inside a registered project's checkout or
// worktree.
func (g *Git) mayBeRoot(dir string) bool {
	if filepath.Clean(dir) == filepath.Clean(g.root) {
		return false
	}
	for _, r := range g.Snapshot().Projects {
		if fsx.Within(r.Path, dir) {
			return false
		}
		for _, w := range r.Worktrees {
			if w.Path != "" && fsx.Within(w.Path, dir) {
				return false
			}
		}
	}
	return true
}

// ChildRepos lists the git repositories directly inside dir that Register accepts: its
// immediate children that are directories holding a .git directory with a HEAD (an
// empty .git is not a repository), or a .git file pointing into another repository's
// .git/worktrees (a linked worktree, which registers that repository). A submodule's or
// a separate git dir's .git file is skipped: Register refuses them. Hidden children (a
// leading ".") and symlinks are skipped: a link can lead anywhere, and Register would
// add whatever it resolves to. Sorted by name, case-insensitively. An unreadable child
// is skipped; an unreadable dir is an error.
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
		if !repoChild(child) {
			continue
		}
		repos = append(repos, ChildRepo{Path: child, Name: name})
	}
	slices.SortFunc(repos, func(a, b ChildRepo) int {
		return cmp.Or(cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)), cmp.Compare(a.Name, b.Name))
	})
	return repos, nil
}

// maxGitFile bounds the .git file repoChild reads (one "gitdir: <path>" line).
const maxGitFile = 4 << 10

// repoChild reports whether dir is a repository Register accepts, without running git
// (ChildRepos' rule): dir/.git is a directory holding a HEAD file, or a file whose
// gitdir is <repository>/.git/worktrees/<name> (the common dir is then a .git
// directory, as mainWorktreeFromCommonDir requires).
func repoChild(dir string) bool {
	p := filepath.Join(dir, ".git")
	fi, err := os.Lstat(p)
	switch {
	case err != nil:
		return false
	case fi.IsDir():
		head, err := os.Stat(filepath.Join(p, "HEAD"))
		return err == nil && head.Mode().IsRegular()
	case !fi.Mode().IsRegular() || fi.Size() > maxGitFile:
		return false
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return false
	}
	line, _, _ := strings.Cut(string(b), "\n")
	gitdir, ok := strings.CutPrefix(strings.TrimSpace(line), "gitdir:")
	if !ok {
		return false
	}
	gitdir = strings.TrimSpace(gitdir)
	if !filepath.IsAbs(gitdir) {
		gitdir = filepath.Join(dir, gitdir)
	}
	parent := filepath.Dir(filepath.Clean(gitdir))
	return filepath.Base(parent) == "worktrees" && filepath.Base(filepath.Dir(parent)) == ".git"
}
