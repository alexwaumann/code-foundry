package command

import (
	"context"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// project.branch.delete (docs/notes/orch-cli-batch.md, W4 finding 3): once a worktree
// is removed, --delete-branch has nothing to point at; an orchestrator told to discard
// a child's work then deleted its branch, and origin's, with raw git.

// branchDeleteCommand is project.branch.delete.
func branchDeleteCommand(b ProjectBackend, notGit NotGitFunc) Command {
	return Command{
		Name:      "project.branch.delete",
		NoPalette: true,
		Title:     "Delete Branch",
		Description: "Delete a branch no worktree has checked out (its worktree removed); remote: origin's too. " +
			"Without force the branch, and origin's copy, must be merged into the default branch (or landed there " +
			"squash- or rebase-merged); otherwise nothing is deleted and the error counts the unmerged commits.",
		Category: "Project",
		Args: []ArgSpec{
			{Name: "project", Type: String, Required: true, Context: ContextProject, Positional: true, ID: ProjectID, Description: ProjectRefHelp},
			{Name: "branch", Type: String, Required: true, Positional: true, Description: "Branch name"},
			{Name: "force", Type: Bool, Description: "Delete it even when not merged (its commits are lost, on origin too with --remote)"},
			{Name: "remote", Type: Bool, Description: "Also delete the branch on origin"},
		},
		When:           func(c Context) bool { return hasProject(c) && !notGit(c) },
		WhyUnavailable: notGit.whyNotGit,
		Confirm:        "Delete branch {branch} of project {project}?",
		DynamicConfirm: func(_ context.Context, _ Context, a Args) string {
			if a.Bool("remote") {
				return "Delete branch " + a.String("branch") + " of project " + a.String("project") + ", and on origin?"
			}
			return ""
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			id, err := resolveProjectRef(ctx, b, a.String("project"))
			if err != nil {
				return Result{}, err
			}
			branch := a.String("branch")
			res, err := b.DeleteBranch(ctx, connect.NewRequest(&v1.DeleteBranchRequest{
				ProjectId: id, Branch: branch, Force: a.Bool("force"), Remote: a.Bool("remote"),
			}))
			if err != nil {
				return Result{}, err
			}
			var where []string
			if res.Msg.GetLocalDeleted() {
				where = append(where, "locally")
			}
			if res.Msg.GetRemoteDeleted() {
				where = append(where, "on origin")
			}
			msg := "deleted branch " + branch + " " + strings.Join(where, " and ")
			if a.Bool("remote") && !res.Msg.GetRemoteDeleted() {
				msg += " (origin did not have it)"
			}
			return Result{Message: msg, JSON: res.Msg}, nil
		},
	}
}
