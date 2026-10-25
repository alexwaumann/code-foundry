package projecttest

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// Inspect implements project.Store. Folders, when it has path, answers; else the path is
// read from disk without git: a repository when it has .git (no walk up), its child
// repositories from project.ChildRepos otherwise. AllowedRoot applies as in Register.
func (f *Fake) Inspect(_ context.Context, path string) (project.Folder, error) {
	f.mu.Lock()
	f.Calls = append(f.Calls, "Inspect "+path)
	folder, known := f.Folders[filepath.Clean(path)]
	root := f.AllowedRoot
	f.mu.Unlock()
	if path == "" || !filepath.IsAbs(path) {
		return project.Folder{}, fmt.Errorf("%w: path must be absolute", project.ErrInvalidArgument)
	}
	if root != "" && !fsx.Within(root, filepath.Clean(path)) {
		return project.Folder{}, fmt.Errorf("%w: %s is outside your home directory", project.ErrInvalidArgument, path)
	}
	if known {
		return folder, nil
	}
	if _, err := os.Lstat(filepath.Join(path, ".git")); err == nil {
		return project.Folder{Path: filepath.Clean(path), IsRepo: true}, nil
	}
	repos, err := project.ChildRepos(path)
	if err != nil {
		return project.Folder{}, err
	}
	return project.Folder{Path: filepath.Clean(path), ChildRepos: repos}, nil
}
