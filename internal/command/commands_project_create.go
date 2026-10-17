package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// ProjectBackend is the slice of ProjectService project.create, project.github.publish and
// project.delete need, in generated Connect signatures. The ProjectService handler, a
// ProjectServiceClient and codefoundryv1connect.UnimplementedProjectServiceHandler satisfy it.
type NewProjectBackend interface {
	Create(context.Context, *connect.Request[v1.CreateProjectRequest]) (*connect.Response[v1.CreateProjectResponse], error)
	Publish(context.Context, *connect.Request[v1.PublishProjectRequest]) (*connect.Response[v1.PublishProjectResponse], error)
	Delete(context.Context, *connect.Request[v1.DeleteProjectRequest]) (*connect.Response[v1.DeleteProjectResponse], error)
}

var (
	_ NewProjectBackend = codefoundryv1connect.ProjectServiceHandler(nil)
	_ NewProjectBackend = codefoundryv1connect.ProjectServiceClient(nil)
)

// HasOriginFunc reports whether the context's project has an "origin" remote. Nil
// means never.
type HasOriginFunc func(Context) bool

// DeletableFunc reports whether the context's project is directly inside the projects
// directory (made by project.create), so project.delete may remove it. Nil means never.
type DeletableFunc func(Context) bool

// ProjectDeps are project.create's, project.github.publish's and project.delete's dependencies.
type NewProjectDeps struct {
	// Backend runs them; nil registers against UnimplementedProjectServiceHandler.
	Backend NewProjectBackend
	// NotGit and HasOrigin gate project.github.publish: a git project without origin.
	NotGit    NotGitFunc
	HasOrigin HasOriginFunc
	// Deletable gates project.delete.
	Deletable DeletableFunc
}

// hasOriginReason is why project.github.publish is unavailable for a project with origin.
const hasOriginReason = "project already has an origin remote"

// notDeletableReason is why project.delete is unavailable for a project elsewhere.
const notDeletableReason = "project is not in the projects directory; use Remove Project"

// publishVisibilities maps project.github.publish's visibility to the proto enum.
var publishVisibilities = map[string]v1.RepositoryVisibility{
	"public":   v1.RepositoryVisibility_REPOSITORY_VISIBILITY_PUBLIC,
	"internal": v1.RepositoryVisibility_REPOSITORY_VISIBILITY_INTERNAL,
	"private":  v1.RepositoryVisibility_REPOSITORY_VISIBILITY_PRIVATE,
}

// RegisterProjects registers project.create, project.github.publish and project.delete. In the
// app, the Add Project dialog's New tab invokes project.create (and project.delete, confirmed,
// when the new project is cancelled), and project.github.publish opens the publish dialog
// (its owner and visibility pickers); the CLI runs all three directly.
func RegisterNewProjects(r *Registry, d NewProjectDeps) error {
	b := d.Backend
	if b == nil {
		b = codefoundryv1connect.UnimplementedProjectServiceHandler{}
	}
	notGit := d.NotGit.or()
	hasOrigin := d.HasOrigin
	if hasOrigin == nil {
		hasOrigin = func(Context) bool { return false }
	}
	deletable := d.Deletable
	if deletable == nil {
		deletable = func(Context) bool { return false }
	}
	return r.RegisterAll(
		Command{
			Name:  "project.create",
			Title: "New Project",
			Description: "Start an empty project in ~/.code-foundry/projects/<name>: git init on the default branch " +
				"(init.defaultBranch, else main) and an empty initial commit. Refuses when that folder exists.",
			Category: "Project",
			Args: []ArgSpec{
				{Name: "name", Type: String, Required: true, Positional: true,
					Description: "Folder name: letters, digits, -, _ and . (not starting with .)"},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Create(ctx, connect.NewRequest(&v1.CreateProjectRequest{Name: a.String("name")}))
				if err != nil {
					return Result{}, err
				}
				project := res.Msg.GetProject()
				return Result{Message: "created " + project.GetName() + " in " + project.GetPath() + " (" + project.GetId() + ")", JSON: project}, nil
			},
		},
		Command{
			Name:  "project.github.publish",
			Title: "Publish to GitHub",
			Description: "Create a GitHub repository for a git project without an origin remote and push it, with " +
				"`gh repo create <owner>/<name> --source <project> --remote origin --push`. Organizations may refuse " +
				"some visibilities; gh's error is shown as is.",
			Category: "Project",
			Args: []ArgSpec{
				{Name: "project", Type: String, Required: true, Context: ContextProject, Description: "Project id"},
				{Name: "owner", Type: String, Required: true, Description: "GitHub user or organization"},
				{Name: "name", Type: String, Description: "Repository name on GitHub (default: the project's name)"},
				{Name: "visibility", Type: Enum, Required: true, Enum: []string{"public", "internal", "private"},
					Description: "Repository visibility"},
			},
			When: func(c Context) bool { return hasProject(c) && !notGit(c) && !hasOrigin(c) },
			WhyUnavailable: func(c Context) string {
				if why := notGit.whyNotGit(c); why != "" {
					return why
				}
				if hasProject(c) && hasOrigin(c) {
					return hasOriginReason
				}
				return ""
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				vis := a.String("visibility")
				res, err := b.Publish(ctx, connect.NewRequest(&v1.PublishProjectRequest{
					ProjectId: a.String("project"), Owner: a.String("owner"), Name: a.String("name"), Visibility: publishVisibilities[vis],
				}))
				if err != nil {
					return Result{}, err
				}
				project := res.Msg.GetProject()
				msg := "published " + project.GetName()
				if slug := project.GetGithubSlug(); slug != "" {
					msg += " to https://github.com/" + slug
				}
				msg += " (" + vis + ")"
				return Result{Message: msg, JSON: project}, nil
			},
		},
		Command{
			Name:  "project.delete",
			Title: "Delete Project",
			Description: "Stop tracking a project made by New Project and delete its folder in ~/.code-foundry/projects. " +
				"Only projects there can be deleted; a repository on GitHub is not touched.",
			Category: "Project",
			Args:     []ArgSpec{{Name: "project", Type: String, Required: true, Context: ContextProject, Description: "Project id"}},
			When:     func(c Context) bool { return hasProject(c) && deletable(c) },
			WhyUnavailable: func(c Context) string {
				if hasProject(c) && !deletable(c) {
					return notDeletableReason
				}
				return ""
			},
			Confirm: "Delete project {project} and its folder on disk? This cannot be undone.",
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("project")
				if _, err := b.Delete(ctx, connect.NewRequest(&v1.DeleteProjectRequest{Id: id})); err != nil {
					return Result{}, err
				}
				return Result{Message: "deleted " + id}, nil
			},
		},
	)
}
