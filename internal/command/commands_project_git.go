package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// gitInitCommand is project.git.init: make a project without git a git repository
// (RepoService.InitGit). Available only for such a project.
func gitInitCommand(b ProjectBackend, projectArg ArgSpec, notGit NotGitFunc) Command {
	return Command{
		Name:  "project.git.init",
		Title: "Initialize Git",
		Description: "Make a project without git a git repository: git init on the default branch " +
			"(init.defaultBranch, else main) and an empty initial commit, so worktrees can branch from it.",
		Category: "Project",
		Args:     []ArgSpec{projectArg},
		When:     func(c Context) bool { return hasProject(c) && notGit(c) },
		WhyUnavailable: func(c Context) string {
			if hasProject(c) && !notGit(c) {
				return "project is already a git repository"
			}
			return ""
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.InitGit(ctx, connect.NewRequest(&v1.InitGitRequest{Id: a.String("project")}))
			if err != nil {
				return Result{}, err
			}
			project := res.Msg.GetProject()
			msg := "initialized git in " + project.GetName()
			if b := project.GetDefaultBranch(); b != "" {
				msg += " on " + b
			}
			return Result{Message: msg, JSON: project}, nil
		},
	}
}
