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

// cleanupConfirm is the prompt when the dry run failed (Run then reports why).
const cleanupConfirm = "Fetch {project} and remove the worktrees Code Foundry made whose work is already in the default branch? Branches are kept."

// RegisterProjectCleanup registers project.worktree.cleanup: reclaim the disk space of
// worktrees whose work is already in origin/<default>. A worktree goes only when it is
// not the main one, made by Code Foundry (recorded when made; a `git worktree add` under
// its worktrees directory does not count), on a branch, without staged, modified,
// untracked or conflicted files, not made in the last 10 minutes with no commit since,
// its work is in origin/<default> (its branch is, or a rebased or squash-merged copy of
// its changes is), and no thread (but an archived one), running terminal or workspace
// holds it. The confirmation lists what would go and what stays, with why. It fetches
// first and the daemon checks again after the fetch; removal is `git worktree remove`
// without --force, and branches are never deleted.
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
		Description: "Fetch, then remove the project's worktrees (or one) whose work is already in origin/<default>: " +
			"made by Code Foundry (not one added by hand under its worktrees directory), no uncommitted changes, " +
			"its branch merged (or a rebased or squash-merged copy of its changes), not made in the last 10 minutes " +
			"with no commit since, no thread (archived ones aside), terminal or workspace on it. " +
			"Without --yes it lists what would be removed and what is kept, with why. Branches are kept.",
		Category: "Project",
		Args: []ArgSpec{
			{Name: "project", Type: String, Required: true, Context: ContextProject, Positional: true, Description: "Project name or id"},
			{Name: "path", Type: Path, Positional: true, Description: "One worktree (default: every merged one)"},
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

// cleanupPrompt is the confirm prompt from a dry run: every worktree that would be
// removed and every one kept, each with its branch, path and why, so a user or an agent
// sees the outcome before confirming. "" (the static prompt) when the dry run named
// nothing.
func cleanupPrompt(res *v1.CleanupWorktreesResponse, path string) string {
	rm, sk := res.GetRemoved(), res.GetSkipped()
	if path != "" {
		switch {
		case len(rm) > 0:
			w := rm[0].GetWorktree()
			return fmt.Sprintf("Remove the worktree of %s at %s (%s)? The branch is kept. It is checked again after a fetch.",
				worktreeLabel(w), w.GetPath(), rm[0].GetReason())
		case len(sk) > 0:
			w := sk[0].GetWorktree()
			return fmt.Sprintf("Fetch and check the worktree of %s at %s again? Right now it is kept: %s.",
				worktreeLabel(w), w.GetPath(), sk[0].GetReason())
		}
		return ""
	}
	if len(rm)+len(sk) == 0 {
		return ""
	}
	var b strings.Builder
	if len(rm) == 0 {
		b.WriteString("Fetch and remove the worktrees Code Foundry made whose work is in the default branch? None would be removed now; each is checked again after the fetch.")
	} else {
		fmt.Fprintf(&b, "Fetch, then remove %s (branches are kept; each is checked again after the fetch):", plural(len(rm), "worktree"))
		for _, r := range rm {
			writeCleanupLine(&b, r.GetWorktree(), r.GetReason())
		}
	}
	if len(sk) > 0 {
		fmt.Fprintf(&b, "\nKeep %d:", len(sk))
		for _, s := range sk {
			writeCleanupLine(&b, s.GetWorktree(), s.GetReason())
		}
	}
	return b.String()
}

// writeCleanupLine adds "- cf/a at /path: reason" on its own line.
func writeCleanupLine(b *strings.Builder, w *v1.Worktree, reason string) {
	fmt.Fprintf(b, "\n- %s at %s: %s", worktreeLabel(w), w.GetPath(), reason)
}

// cleanupMessage says what a cleanup did: "Removed 2 worktrees: cf/a (branch is in
// origin/main), cf/b (...); kept 1 worktree: cf/c (uncommitted changes)".
func cleanupMessage(res *v1.CleanupWorktreesResponse) string {
	var parts []string
	if rm := res.GetRemoved(); len(rm) > 0 {
		names := make([]string, len(rm))
		for i, r := range rm {
			names[i] = worktreeLabel(r.GetWorktree()) + " (" + r.GetReason() + ")"
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
