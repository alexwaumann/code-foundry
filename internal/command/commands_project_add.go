package command

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// CloneFunc clones a github.com repository named by ref (owner/repo or an
// https://github.com URL) into the projects directory and registers it: ProjectService.Clone
// without the stream. progress gets every output line. A malformed ref is
// InvalidArgument. The daemon wires the ProjectService handler's CloneRef.
type CloneFunc func(ctx context.Context, ref string, progress func(*v1.CloneProgress)) (*v1.Project, error)

// AddProjectHint is project.add's answer outside the app without a folder, where there is
// no dialog.
const AddProjectHint = "Add a project from the CLI with `code-foundry project add <folder>` " +
	"or `code-foundry project clone <owner/repo>`; in the app, project.add opens the Add Project dialog."

// RegisterProjectAdd registers project.add (the Add Project dialog in the app; on the CLI it
// registers a folder through repos.Register, or prints AddProjectHint without one) and
// project.clone. A nil repos makes project.add with a folder fail with Unimplemented; a nil
// clone does the same for project.clone.
func RegisterProjectAdd(r *Registry, projects ProjectBackend, clone CloneFunc) error {
	if projects == nil {
		projects = codefoundryv1connect.UnimplementedProjectServiceHandler{}
	}
	if clone == nil {
		clone = func(context.Context, string, func(*v1.CloneProgress)) (*v1.Project, error) {
			return nil, connect.NewError(connect.CodeUnimplemented, errors.New("clone is not configured"))
		}
	}
	return r.RegisterAll(
		Command{
			Name:  "project.add",
			Title: "Add Project",
			Description: "Add a project: start a new one, add a folder on this Mac, or clone a repository from GitHub. " +
				"Opens the Add Project dialog in the app.",
			Category: "Project",
			Args: []ArgSpec{
				{Name: "path", Type: Path, Positional: true,
					Description: "Project folder to add without the dialog (a git repository or any folder under home)"},
			},
			// The GUI presents it (the dialog, which calls ProjectService.Register itself) and
			// never invokes it; this is the CLI's answer. The palette does not prompt for
			// an optional path.
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				path := a.Path("path")
				if path == "" {
					return Result{Message: AddProjectHint}, nil
				}
				res, err := projects.Register(ctx, connect.NewRequest(&v1.RegisterProjectRequest{Path: path}))
				if err != nil {
					return Result{}, err
				}
				project := res.Msg.GetProject()
				return Result{Message: "registered " + project.GetName() + " (" + project.GetId() + ")", JSON: project}, nil
			},
		},
		Command{
			Name:  "project.clone",
			Title: "Clone from GitHub",
			Description: "Clone a github.com repository with `gh repo clone` into ~/.code-foundry/projects/<owner>/<repo> " +
				"and add it as a project. Refuses when that folder exists.",
			Category: "Project",
			Args: []ArgSpec{
				{Name: "repo", Type: String, Required: true, Positional: true, Description: "owner/repo or https://github.com/owner/repo"},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				project, err := clone(ctx, a.String("repo"), nil)
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "cloned " + project.GetName() + " into " + project.GetPath() + " (" + project.GetId() + ")", JSON: project}, nil
			},
		},
	)
}
