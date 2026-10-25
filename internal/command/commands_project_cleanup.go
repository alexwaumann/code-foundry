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
//
// A worktree kept only for its uncommitted changes (every other condition passes) is
// asked about: the first prompt lists it as removable if that work is deleted, and after
// the run removed the others a second-stage confirmation names each with its counts and
// re-runs with --force, which removes those too (`git worktree remove --force`). Declined
// (or under --yes), the run's own result stands, as before.
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
			Project: a.String("project"), Path: a.Path("path"), DryRun: dry, Force: a.Bool("force"),
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
			"no thread (archived aside) with it as its cwd or a checkout of its projects, and no terminal in it. Without --yes: lists what goes and stays. Branches are kept. " +
			"One kept only for uncommitted changes is asked about again, with its counts, before they are deleted; --yes does " +
			"not answer that question (it is kept), --force does.",
		Category: "Project",
		Args: []ArgSpec{
			{Name: "project", Type: String, Required: true, Context: ContextProject, Positional: true, Description: "Project name or id"},
			{Name: "path", Type: Path, Positional: true, Description: "One worktree (default: every merged one)"},
			{Name: "force", Type: Bool, Description: "Also remove the ones kept only for uncommitted changes, deleting them (without it: asked)"},
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
			done := Result{Message: cleanupMessage(res), JSON: res}
			if dirty := uncommittedSkips(res); len(dirty) > 0 && !a.Bool("force") {
				return Result{}, &ConfirmError{
					Command: "project.worktree.cleanup", Title: deleteWorkTitle,
					Message: cleanupForcePrompt(res, dirty, a.Path("path")), Args: forceArgs(), Declined: &done,
				}
			}
			return done, nil
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
		case len(rm) > 0 && rm[0].GetUncommitted():
			w := rm[0].GetWorktree()
			return fmt.Sprintf("Remove the worktree of %s at %s (%s) and delete its uncommitted work (%s) for good? The branch is kept. It is checked again after a fetch.",
				worktreeLabel(w), w.GetPath(), rm[0].GetReason(), changeCounts(w.GetStatus()))
		case len(rm) > 0:
			w := rm[0].GetWorktree()
			return fmt.Sprintf("Remove the worktree of %s at %s (%s)? The branch is kept. It is checked again after a fetch.",
				worktreeLabel(w), w.GetPath(), rm[0].GetReason())
		case len(sk) > 0 && sk[0].GetUncommitted():
			w := sk[0].GetWorktree()
			return fmt.Sprintf("Fetch and check the worktree of %s at %s again? Its work is otherwise removable, but it has uncommitted work (%s); you are asked again before that is deleted.",
				worktreeLabel(w), w.GetPath(), changeCounts(w.GetStatus()))
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
			reason := r.GetReason()
			if r.GetUncommitted() {
				reason += "; deletes its " + changeCounts(r.GetWorktree().GetStatus())
			}
			writeCleanupLine(&b, r.GetWorktree(), reason)
		}
	}
	var keep []*v1.SkippedWorktree
	if dirty := uncommittedSkips(res); len(dirty) > 0 {
		b.WriteString("\nAlso removable if their uncommitted work is deleted (you are asked again first):")
		for _, w := range dirty {
			writeWorkLine(&b, w)
		}
	}
	for _, s := range sk {
		if !s.GetUncommitted() {
			keep = append(keep, s)
		}
	}
	if len(keep) > 0 {
		fmt.Fprintf(&b, "\nKeep %d:", len(keep))
		for _, s := range keep {
			writeCleanupLine(&b, s.GetWorktree(), s.GetReason())
		}
	}
	return b.String()
}

// uncommittedSkips are the worktrees a cleanup kept only for their uncommitted changes.
func uncommittedSkips(res *v1.CleanupWorktreesResponse) []*v1.Worktree {
	var out []*v1.Worktree
	for _, s := range res.GetSkipped() {
		if s.GetUncommitted() {
			out = append(out, s.GetWorktree())
		}
	}
	return out
}

// cleanupForcePrompt is the second-stage confirmation after a cleanup run that kept
// dirty worktrees whose work is otherwise in the default branch: what it removed, then
// each kept one with its counts, and the question whether to delete that work.
func cleanupForcePrompt(res *v1.CleanupWorktreesResponse, dirty []*v1.Worktree, path string) string {
	if path != "" && len(dirty) == 1 {
		w := dirty[0]
		return fmt.Sprintf("The work of %s at %s is in the default branch, but the worktree has uncommitted work: %s.\n\n"+
			"Remove the worktree and delete that work for good? The branch is kept.", worktreeLabel(w), w.GetPath(), changeCounts(w.GetStatus()))
	}
	var b strings.Builder
	if rm := res.GetRemoved(); len(rm) > 0 {
		names := make([]string, len(rm))
		for i, r := range rm {
			names[i] = worktreeLabel(r.GetWorktree())
		}
		fmt.Fprintf(&b, "Removed %s: %s.\n\n", plural(len(rm), "worktree"), strings.Join(names, ", "))
	}
	what := "worktree"
	if len(res.GetRemoved()) > 0 {
		what = "more worktree"
	}
	fmt.Fprintf(&b, "The work of %s is in the default branch, but %s uncommitted work:", plural(len(dirty), what), hasHave(len(dirty)))
	for _, w := range dirty {
		writeWorkLine(&b, w)
	}
	if len(dirty) == 1 {
		b.WriteString("\n\nRemove it too and delete that work for good? Its branch is kept.")
	} else {
		b.WriteString("\n\nRemove them too and delete that work for good? Branches are kept.")
	}
	return b.String()
}

func hasHave(n int) string {
	if n == 1 {
		return "it has"
	}
	return "they have"
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
			reason := r.GetReason()
			if r.GetUncommitted() {
				reason += "; uncommitted changes deleted"
			}
			names[i] = worktreeLabel(r.GetWorktree()) + " (" + reason + ")"
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
