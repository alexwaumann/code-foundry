package repo

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Projects without git (docs/notes/add-project-2-nogit.md).
//
// Register accepts a directory outside any git repository as a project with Git
// false. Its reconcile runs no git command: it checks that the directory exists and
// whether .git has appeared, and publishes one synthetic main worktree at the project
// path (empty branch and head, zero status). Status and base jobs are no-ops for it,
// it has no watches, and the poll loop reconciles it every round (a stat), which is
// how a `git init` run outside the app is noticed. InitGit runs git init and an empty
// initial commit, then refreshes, which flips the project to git and lets the normal
// reconcile take over.

// initialCommitMessage is the message of the empty commit InitGit makes, so the new
// repository has a HEAD that worktrees can branch from.
const initialCommitMessage = "Initial commit"

// probeGit reports whether dir is a git project (has .git). It fails when dir does not
// exist or is not a directory, like a reconcile of a moved repository.
func probeGit(dir string) (bool, error) {
	fi, err := os.Stat(dir)
	if err != nil {
		return false, fmt.Errorf("project directory: %w", err)
	}
	if !fi.IsDir() {
		return false, fmt.Errorf("project path %s is not a directory", dir)
	}
	_, err = os.Lstat(filepath.Join(dir, ".git"))
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, os.ErrNotExist):
		return false, nil
	default:
		return false, fmt.Errorf("project directory: %w", err)
	}
}

// hasDotGit reports whether dir/.git exists, treating errors as "no".
func hasDotGit(dir string) bool {
	_, err := os.Lstat(filepath.Join(dir, ".git"))
	return err == nil
}

// plainCheckout clears m's git-derived fields and returns the one synthetic worktree
// of a project without git: the project directory itself.
func plainCheckout(m *repoMeta) []listedWorktree {
	m.Git = false
	m.DefaultBranch, m.GitHubSlug, m.OriginURL, m.Remotes = "", "", "", nil
	return []listedWorktree{{Path: m.Path}}
}

// isNotARepository reports whether err is git saying the directory is not inside a
// repository (as opposed to git failing for another reason).
func isNotARepository(err error) bool {
	var ge *GitError
	return errors.As(err, &ge) && ge.ExitCode == 128 &&
		strings.Contains(strings.ToLower(ge.Stderr), "not a git repository")
}

// requireGit returns an ErrFailedPrecondition error for a project without git.
func requireGit(m *repoMeta) error {
	if m.Git {
		return nil
	}
	return fmt.Errorf("%w: %s is %w", ErrFailedPrecondition, m.Name, ErrNotGit)
}

// InitGit implements Store.
func (g *Git) InitGit(ctx context.Context, id string) (Repo, error) {
	st := g.repo(id)
	if st == nil {
		return Repo{}, fmt.Errorf("%w: repo %q", ErrNotFound, id)
	}
	m := st.meta.Load()
	if m.Git || hasDotGit(m.Path) {
		// .git may have appeared since the last poll; let the snapshot catch up.
		_ = g.refresh(ctx, id)
		return Repo{}, fmt.Errorf("%w: %s is already a git repository", ErrFailedPrecondition, m.Name)
	}
	branch, initErr := InitRepository(ctx, g.runner, m.Path)
	if initErr != nil && !hasDotGit(m.Path) {
		return Repo{}, fmt.Errorf("%w: git init in %s: %w", ErrFailedPrecondition, m.Path, initErr)
	}
	g.log.Info("git initialized", "repo", id, "path", m.Path, "branch", branch, "err", initErr)
	if err := g.refresh(ctx, id); err != nil {
		return Repo{}, errors.Join(initErr, err)
	}
	if initErr != nil {
		// The repository exists but has no commit (an unset user.name, a failing
		// hook or signing): say so, the project is a git project now regardless.
		return Repo{}, fmt.Errorf("%w: initialized git in %s, but the initial commit failed: %w", ErrFailedPrecondition, m.Path, initErr)
	}
	r, ok := g.Snapshot().Repo(id)
	if !ok {
		return Repo{}, fmt.Errorf("%w: repo %s was unregistered concurrently", ErrNotFound, id)
	}
	return r, nil
}

// InitRepository runs `git init -b <branch>` in dir and makes an empty "Initial
// commit", returning the branch: `git config --get init.defaultBranch`, else "main".
// A failed commit is returned after a successful init (dir/.git then exists).
func InitRepository(ctx context.Context, run Runner, dir string) (string, error) {
	branch := "main"
	if out, err := run.Run(ctx, dir, "config", "--get", "init.defaultBranch"); err == nil {
		if b := strings.TrimSpace(string(out)); b != "" {
			branch = b
		}
	}
	if _, err := run.Run(ctx, dir, "init", "--quiet", "-b", branch); err != nil {
		return branch, err
	}
	if _, err := run.Run(ctx, dir, "commit", "--quiet", "--allow-empty", "-m", initialCommitMessage); err != nil {
		return branch, err
	}
	return branch, nil
}
