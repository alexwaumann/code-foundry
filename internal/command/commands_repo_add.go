package command

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// CloneFunc clones a github.com repository named by ref (owner/repo or an
// https://github.com URL) into the projects directory and registers it: RepoService.Clone
// without the stream. progress gets every output line. A malformed ref is
// InvalidArgument. The daemon wires the RepoService handler's CloneRef.
type CloneFunc func(ctx context.Context, ref string, progress func(*v1.CloneProgress)) (*v1.Repo, error)

// AddProjectHint is repo.add's answer outside the app, where there is no dialog.
const AddProjectHint = "Add a project from the CLI with `code-foundry repo register --path <folder>` " +
	"or `code-foundry repo clone <owner/repo>`; in the app, repo.add opens the Add Project dialog."

// RegisterRepoAdd registers repo.add (the Add Project dialog; GUI presentation) and
// repo.clone. A nil clone makes repo.clone fail with Unimplemented.
func RegisterRepoAdd(r *Registry, clone CloneFunc) error {
	if clone == nil {
		clone = func(context.Context, string, func(*v1.CloneProgress)) (*v1.Repo, error) {
			return nil, connect.NewError(connect.CodeUnimplemented, errors.New("clone is not configured"))
		}
	}
	return r.RegisterAll(
		Command{
			Name:  "repo.add",
			Title: "Add Project",
			Description: "Add a project: start a new one, add a folder on this Mac, or clone a repository from GitHub. " +
				"Opens the Add Project dialog in the app.",
			Category: "Project",
			// The GUI presents it (the dialog) and never invokes it; this is the CLI's answer.
			Run: func(context.Context, Context, Args) (Result, error) {
				return Result{Message: AddProjectHint}, nil
			},
		},
		Command{
			Name:  "repo.clone",
			Title: "Clone from GitHub",
			Description: "Clone a github.com repository with `gh repo clone` into ~/.code-foundry/projects/<owner>/<repo> " +
				"and add it as a project. Refuses when that folder exists.",
			Category: "Project",
			Args: []ArgSpec{
				{Name: "repo", Type: String, Required: true, Positional: true, Description: "owner/repo or https://github.com/owner/repo"},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				repo, err := clone(ctx, a.String("repo"), nil)
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "cloned " + repo.GetName() + " into " + repo.GetPath() + " (" + repo.GetId() + ")", JSON: repo}, nil
			},
		},
	)
}
