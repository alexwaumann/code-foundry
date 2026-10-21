package project

import (
	"context"
	"errors"
	"strings"
)

// Removing a worktree with initialized submodules (fuzz finding git 8): git refuses
// every such worktree, clean or not; RemoveWorktree retries with --force when that
// loses nothing.

// refusedForSubmodules reports git's refusal to remove a worktree with an initialized
// submodule ("working trees containing submodules cannot be moved or removed").
func refusedForSubmodules(err error) bool {
	var ge *GitError
	return errors.As(err, &ge) && strings.Contains(ge.Stderr, "containing submodules")
}

// submodulesSafe reports whether no submodule of the worktree at dir, recursively,
// has a commit (on HEAD or a local branch) that none of its remote-tracking refs has:
// `git worktree remove --force` deletes the submodules' repositories with it. Any
// failure is "not safe".
func (g *Git) submodulesSafe(ctx context.Context, dir string) bool {
	out, err := g.runner.Run(ctx, dir, "submodule", "foreach", "--quiet", "--recursive",
		"git rev-list -1 HEAD --branches --not --remotes")
	return err == nil && len(strings.TrimSpace(string(out))) == 0
}
