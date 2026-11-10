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

// ProjectCleanupDeps are project.worktree.cleanup's dependencies.
type ProjectCleanupDeps struct {
	// Project resolves the project and removes worktrees (ProjectService.CleanupWorktrees).
	// Nil works like UnimplementedProjectServiceHandler.
	Project ProjectBackend
	// GitOps fetches first, the same operation git.fetch runs (so the GUI shows its
	// toast). Nil works like UnimplementedGitOpsServiceHandler.
	GitOps GitOpsBackend
	// NotGit makes the command unavailable in a project without git.
	NotGit NotGitFunc
}

// cleanupConfirm is the prompt when the dry run failed or named nothing (Run then
// reports what it removed after the fetch).
const cleanupConfirm = "Fetch {project} and remove the worktrees Code Foundry made whose work is already in the default branch? Branches are kept."

// RegisterProjectCleanup registers project.worktree.cleanup: reclaim the disk space of
// worktrees whose work is already in origin/<default>. A worktree goes only when it is
// not the main one, made by Code Foundry (recorded when made; a `git worktree add` under
// its worktrees directory does not count), on a branch, without staged, modified,
// untracked or conflicted files, not made in the last 10 minutes with no commit since,
// its work is in origin/<default> (its branch is, or a rebased or squash-merged copy of
// its changes is), and no thread (but an archived one), running terminal or workspace
// holds it. The confirmation lists what would go, each with a short why; the result
// names what went. Nothing about the worktrees kept: a worktree with uncommitted work is
// never cleaned up (project.worktree.remove deletes it, asking first). It fetches first
// and the daemon checks again after the fetch; removal is `git worktree remove` without
// --force, and branches are never deleted. With a path, a worktree that stays fails the
// command with why.
func RegisterProjectCleanup(r *Registry, d ProjectCleanupDeps) error {
	projectB := d.Project
	if projectB == nil {
		projectB = codefoundryv1connect.UnimplementedProjectServiceHandler{}
	}
	ops := d.GitOps
	if ops == nil {
		ops = codefoundryv1connect.UnimplementedGitOpsServiceHandler{}
	}
	notGit := d.NotGit.or()
	cleanup := func(ctx context.Context, a Args, dry bool) (*v1.CleanupWorktreesResponse, error) {
		res, err := projectB.CleanupWorktrees(ctx, connect.NewRequest(&v1.CleanupWorktreesRequest{
			Project: a.String("project"), Path: a.Path("path"), DryRun: dry,
		}))
		if err != nil {
			return nil, err
		}
		return res.Msg, nil
	}
	return r.Register(Command{
		Name:  "project.worktree.cleanup",
		Title: "Clean Up Merged Worktrees",
		Description: "Fetch, then remove the project's worktrees (or one) whose work is in origin/<default>: " +
			"made by Code Foundry (not by hand), clean, merged (or a rebased/squashed copy), not new and empty (10 min), " +
			"no thread (archived aside) with it as its cwd or a checkout of its projects, and no terminal in it. " +
			"Without --yes: lists what goes. Reports only what it removed. Branches are kept. A worktree with uncommitted " +
			"work is never cleaned up: remove it with project.worktree.remove.",
		Category: "Project",
		Args: []ArgSpec{
			{Name: "project", Type: String, Required: true, Context: ContextProject, ID: ProjectID, Positional: true, Description: ProjectRefHelp},
			{Name: "path", Type: Path, Positional: true, Description: "One worktree (default: every merged one); fails with why when it stays"},
		},
		When:           func(c Context) bool { return hasProject(c) && !notGit(c) },
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
			main, hasOrigin, err := fetchTarget(ctx, projectB, dry.GetProjectId())
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
func fetchTarget(ctx context.Context, b ProjectBackend, id string) (main string, hasOrigin bool, err error) {
	res, err := b.List(ctx, connect.NewRequest(&v1.ListProjectsRequest{}))
	if err != nil {
		return "", false, err
	}
	for _, r := range res.Msg.GetProjects() {
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
	return "", false, connect.NewError(connect.CodeNotFound, fmt.Errorf("project %q is not registered", id))
}

// worktreeLabel names a worktree in messages: its branch, else its directory.
func worktreeLabel(w *v1.Worktree) string {
	if b := w.GetBranch(); b != "" {
		return b
	}
	return filepath.Base(w.GetPath())
}

// cleanupKindLabel is a removed worktree's why in a few words ("merged",
// "squash-merged", "no commits"), its reason for another rule.
func cleanupKindLabel(r *v1.RemovedWorktree) string {
	switch r.GetKind() {
	case v1.CleanupKind_CLEANUP_KIND_MERGED:
		return "merged"
	case v1.CleanupKind_CLEANUP_KIND_SQUASH_MERGED:
		return "squash-merged"
	case v1.CleanupKind_CLEANUP_KIND_NO_COMMITS:
		return "no commits"
	}
	return r.GetReason()
}

// cleanupBase is the branch the removed worktrees' work is in ("origin/main"), from the
// first one's status, or "the default branch".
func cleanupBase(rm []*v1.RemovedWorktree) string {
	for _, r := range rm {
		if b := r.GetWorktree().GetStatus().GetBaseRef(); b != "" {
			return b
		}
	}
	return "the default branch"
}

// cleanupPrompt is the confirm prompt from a dry run: the worktrees that would be
// removed, each with a short why ("Remove 2 merged worktrees? …\n- cf/a (merged)"). ""
// (the static prompt) when the dry run named nothing.
func cleanupPrompt(res *v1.CleanupWorktreesResponse, path string) string {
	rm := res.GetRemoved()
	if len(rm) == 0 {
		return ""
	}
	base := cleanupBase(rm)
	if path != "" || len(rm) == 1 {
		return fmt.Sprintf("Remove the merged worktree %s? Its work is already in %s. The branch is kept.", worktreeLabel(rm[0].GetWorktree()), base)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Remove %d merged worktrees? Their work is already in %s. Branches are kept.", len(rm), base)
	for _, r := range rm {
		fmt.Fprintf(&b, "\n- %s (%s)", worktreeLabel(r.GetWorktree()), cleanupKindLabel(r))
	}
	return b.String()
}

// cleanupMessage says what a cleanup removed: "Removed 2 worktrees: cf/a, cf/b", or
// "No merged worktrees to remove".
func cleanupMessage(res *v1.CleanupWorktreesResponse) string {
	rm := res.GetRemoved()
	if len(rm) == 0 {
		return "No merged worktrees to remove"
	}
	names := make([]string, len(rm))
	for i, r := range rm {
		names[i] = worktreeLabel(r.GetWorktree())
	}
	return "Removed " + plural(len(rm), "worktree") + ": " + strings.Join(names, ", ")
}
