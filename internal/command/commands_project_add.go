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

// AddProjectHint is project.add's answer without a folder when no app window can show the
// dialog.
const AddProjectHint = "Add a project from the CLI with `code-foundry project add <folder>` " +
	"or `code-foundry project clone <owner/repo>`; in the app, project.add opens the Add Project dialog."

// ViewProjectAdd is the ShowView name that opens the Add Project dialog: project.add
// without a folder, from the CLI or a page in a thread, while an app window is open. Like
// ViewComposerHistory an action on the window, not a page.
const ViewProjectAdd = "project.add"

// AddProjectDialog is how project.add without a folder reaches the app windows. The zero
// value reaches none: project.add prints AddProjectHint.
type AddProjectDialog struct {
	Emitter Emitter
	// Viewed reports whether a window shows a thread now (PresenceDeps.Viewed): from a
	// thread no window shows, the dialog does not open (a model must not pop it over what
	// the user is doing). Nil: not checked.
	Viewed func(threadID string) bool
}

// open sends ViewProjectAdd to the windows when one can show it: some window is open and,
// from a thread's CLI, one shows that thread. ok false: nothing was sent.
func (d AddProjectDialog) open(uctx Context) (Result, bool) {
	if d.Emitter == nil || d.Emitter.Windows() == 0 {
		return Result{}, false
	}
	fromThread := uctx.ActiveView == "" && uctx.CallerThreadID != ""
	if fromThread && d.Viewed != nil && !d.Viewed(uctx.CallerThreadID) {
		return Result{}, false
	}
	return EmitTo(d.Emitter, showViewIntent(ViewProjectAdd, "", nil)).CLIResult(uctx), true
}

// RegisterProjectAdd registers project.add (the Add Project dialog: the app presents it
// itself, and the CLI or a page without a folder opens it in the windows through dialog,
// else prints AddProjectHint; with a folder it registers it through repos.Register) and
// project.clone. A nil repos makes project.add with a folder fail with Unimplemented; a nil
// clone does the same for project.clone.
func RegisterProjectAdd(r *Registry, projects ProjectBackend, clone CloneFunc, dialog AddProjectDialog) error {
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
			// never invokes it; this is the CLI's and a page's answer. The palette does not
			// prompt for an optional path.
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				path := a.Path("path")
				if path == "" {
					if res, ok := dialog.open(uctx); ok {
						return res, nil
					}
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
