package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// whyNoWorktree explains an unavailable worktree command: which flag is missing, else
// why git commands are unavailable (W4 finding 2: "not available in this context" did
// not say).
func whyNoWorktree(notGit NotGitFunc) func(Context) string {
	return func(c Context) string {
		if !hasActiveWorktree(c) {
			return "give the worktree with --path"
		}
		return notGit.whyNotGit(c)
	}
}

// worktreeProject is the project a worktree command acts in: project when given, else
// the registered project the worktree at path belongs to. A path no project has is an
// argument error naming --project.
func worktreeProject(ctx context.Context, b ProjectBackend, project, path string) (string, error) {
	if project != "" {
		return project, nil
	}
	res, err := b.List(ctx, connect.NewRequest(&v1.ListProjectsRequest{}))
	if err != nil {
		return "", err
	}
	if id, _, ok := ownerWorktree(res.Msg.GetProjects(), "", realPath(path), ""); ok {
		return id, nil
	}
	return "", InvalidArg("project", "%s is not a worktree of a registered project; give its project with --project "+
		"(code-foundry project list)", path)
}

// gitInitCommand is project.git.init: make a project without git a git repository
// (ProjectService.InitGit). Available only for such a project.
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
