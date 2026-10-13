package command

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// RepoCleanupDeps are repo.worktree.cleanup's dependencies.
type RepoCleanupDeps struct {
	// Repo resolves the project and removes worktrees (RepoService.CleanupWorktrees).
	// Nil works like UnimplementedRepoServiceHandler.
	Repo RepoBackend
	// GitOps fetches first, the same operation git.fetch runs (so the GUI shows its
	// toast). Nil works like UnimplementedGitOpsServiceHandler.
	GitOps GitOpsBackend
	// NotGit makes the command unavailable in a project without git.
	NotGit NotGitFunc
}

// cleanupConfirm is the prompt when nothing is cleanable before the fetch (or the dry
// run failed; Run then reports why).
const cleanupConfirm = "Fetch {repo} and remove the worktrees created by Code Foundry (under its worktrees directory) whose work is already in the default branch? Branches are kept."

// RegisterRepoCleanup registers repo.worktree.cleanup: reclaim the disk space of
// worktrees whose work is already in origin/<default>. A worktree goes only when it is
// not the main one, created by Code Foundry (under its worktrees directory), on a branch, without staged, modified, untracked or conflicted
// files, every commit on it is in origin/<default>, and no live thread, running
// terminal or workspace holds it. It fetches first and the daemon checks again after
// the fetch; removal is `git worktree remove` without --force, and branches are never
// deleted.
func RegisterRepoCleanup(r *Registry, d RepoCleanupDeps) error {
	repoB := d.Repo
	if repoB == nil {
		repoB = codefoundryv1connect.UnimplementedRepoServiceHandler{}
	}
	ops := d.GitOps
	if ops == nil {
		ops = codefoundryv1connect.UnimplementedGitOpsServiceHandler{}
	}
	notGit := d.NotGit.or()
	cleanup := func(ctx context.Context, a Args, dry bool) (*v1.CleanupWorktreesResponse, error) {
		res, err := repoB.CleanupWorktrees(ctx, connect.NewRequest(&v1.CleanupWorktreesRequest{
			Repo: a.String("repo"), Path: a.Path("path"), DryRun: dry,
		}))
		if err != nil {
			return nil, err
		}
		return res.Msg, nil
	}
	return r.Register(Command{
		Name:  "repo.worktree.cleanup",
		Title: "Clean Up Merged Worktrees",
		Description: "Fetch, then remove the project's worktrees (or one) whose work is already in origin/<default>: " +
			"created by Code Foundry (under its worktrees directory), no uncommitted changes, every commit merged, " +
			"no live thread, terminal or workspace. Branches are kept.",
		Category: "Project",
		Args: []ArgSpec{
			{Name: "repo", Type: String, Required: true, Context: ContextRepo, Positional: true, Description: "Repository name or id"},
			{Name: "path", Type: Path, Positional: true, Description: "One worktree (default: every merged one)"},
		},
		When:           func(c Context) bool { return hasRepo(c) && !notGit(c) },
		WhyUnavailable: notGit.whyNotGit,
		Confirm:        cleanupConfirm,
		DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
			res, err := cleanup(ctx, a, true)
			if err != nil {
				return ""
			}
			return cleanupPrompt(res, a.Path("path"))
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			// The dry run resolves the repository (name or id) and fails early for an
			// unknown one or path, before anything is fetched.
			dry, err := cleanup(ctx, a, true)
			if err != nil {
				return Result{}, err
			}
			main, hasOrigin, err := fetchTarget(ctx, repoB, dry.GetRepoId())
			if err != nil {
				return Result{}, err
			}
			if hasOrigin {
				res, err := ops.Fetch(ctx, connect.NewRequest(&v1.GitFetchRequest{WorktreePath: main}))
				if _, err := opResult(res, err); err != nil {
					// Without fresh remote refs nothing is removed.
					return Result{}, err
				}
			}
			res, err := cleanup(ctx, a, false)
			if err != nil {
				return Result{}, err
			}
			return Result{Message: cleanupMessage(res), JSON: res}, nil
		},
	})
}

// fetchTarget returns the main worktree of the repository with id and whether it has
// an origin remote (the base the cleanup rule compares with is origin/<default>).
func fetchTarget(ctx context.Context, b RepoBackend, id string) (main string, hasOrigin bool, err error) {
	res, err := b.List(ctx, connect.NewRequest(&v1.ListReposRequest{}))
	if err != nil {
		return "", false, err
	}
	for _, r := range res.Msg.GetRepos() {
		if r.GetId() != id {
			continue
		}
		main = r.GetPath()
		for _, w := range r.GetWorktrees() {
			if w.GetIsMain() {
				main = w.GetPath()
			}
		}
		return main, slices.Contains(r.GetRemotes(), "origin"), nil
	}
	return "", false, connect.NewError(connect.CodeNotFound, fmt.Errorf("repository %q is not registered", id))
}

// worktreeLabel names a worktree in messages: its branch, else its directory.
func worktreeLabel(w *v1.Worktree) string {
	if b := w.GetBranch(); b != "" {
		return b
	}
	return filepath.Base(w.GetPath())
}

// cleanupPrompt is the confirm prompt from a dry run: the branches whose worktrees go.
// "" (the static prompt) when nothing would be removed.
func cleanupPrompt(res *v1.CleanupWorktreesResponse, path string) string {
	rm := res.GetRemoved()
	if len(rm) == 0 {
		return ""
	}
	if path != "" {
		w := rm[0]
		return fmt.Sprintf("Remove the worktree of %s (%s)? Code Foundry created it (under its worktrees directory) and its work is in %s; the branch is kept. It is checked again after a fetch.",
			worktreeLabel(w), w.GetPath(), cmpBase(w))
	}
	names := make([]string, len(rm))
	for i, w := range rm {
		names[i] = worktreeLabel(w)
	}
	return fmt.Sprintf("Remove %s created by Code Foundry (under its worktrees directory) whose work is in %s: %s? Branches are kept; each is checked again after a fetch.",
		plural(len(rm), "worktree"), cmpBase(rm[0]), strings.Join(names, ", "))
}

// cmpBase is the base a worktree was compared with ("origin/main").
func cmpBase(w *v1.Worktree) string {
	if b := w.GetStatus().GetBaseRef(); b != "" {
		return b
	}
	return "the default branch"
}

// cleanupMessage says what a cleanup did: "Removed 2 worktrees: cf/a, cf/b; kept 1:
// cf/c (uncommitted changes)".
func cleanupMessage(res *v1.CleanupWorktreesResponse) string {
	var parts []string
	if rm := res.GetRemoved(); len(rm) > 0 {
		names := make([]string, len(rm))
		for i, w := range rm {
			names[i] = worktreeLabel(w)
		}
		parts = append(parts, "Removed "+plural(len(rm), "worktree")+": "+strings.Join(names, ", "))
	}
	if sk := res.GetSkipped(); len(sk) > 0 {
		kept := make([]string, len(sk))
		for i, s := range sk {
			kept[i] = worktreeLabel(s.GetWorktree()) + " (" + s.GetReason() + ")"
		}
		head := "kept " + plural(len(sk), "worktree")
		if len(res.GetRemoved()) == 0 {
			head = "Nothing removed; " + head
		}
		parts = append(parts, head+": "+strings.Join(kept, ", "))
	}
	if len(parts) == 0 {
		return "No worktrees to clean up"
	}
	return strings.Join(parts, "; ")
}
