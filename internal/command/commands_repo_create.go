package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// ProjectBackend is the slice of RepoService repo.create, repo.github.publish and
// repo.delete need, in generated Connect signatures. The RepoService handler, a
// RepoServiceClient and codefoundryv1connect.UnimplementedRepoServiceHandler satisfy it.
type ProjectBackend interface {
	Create(context.Context, *connect.Request[v1.CreateRepoRequest]) (*connect.Response[v1.CreateRepoResponse], error)
	Publish(context.Context, *connect.Request[v1.PublishRepoRequest]) (*connect.Response[v1.PublishRepoResponse], error)
	Delete(context.Context, *connect.Request[v1.DeleteRepoRequest]) (*connect.Response[v1.DeleteRepoResponse], error)
}

var (
	_ ProjectBackend = codefoundryv1connect.RepoServiceHandler(nil)
	_ ProjectBackend = codefoundryv1connect.RepoServiceClient(nil)
)

// HasOriginFunc reports whether the context's project has an "origin" remote. Nil
// means never.
type HasOriginFunc func(Context) bool

// DeletableFunc reports whether the context's project is directly inside the projects
// directory (made by repo.create), so repo.delete may remove it. Nil means never.
type DeletableFunc func(Context) bool

// ProjectDeps are repo.create's, repo.github.publish's and repo.delete's dependencies.
type ProjectDeps struct {
	// Backend runs them; nil registers against UnimplementedRepoServiceHandler.
	Backend ProjectBackend
	// NotGit and HasOrigin gate repo.github.publish: a git project without origin.
	NotGit    NotGitFunc
	HasOrigin HasOriginFunc
	// Deletable gates repo.delete.
	Deletable DeletableFunc
}

// hasOriginReason is why repo.github.publish is unavailable for a project with origin.
const hasOriginReason = "project already has an origin remote"

// notDeletableReason is why repo.delete is unavailable for a project elsewhere.
const notDeletableReason = "project is not in the projects directory; use Remove Project"

// publishVisibilities maps repo.github.publish's visibility to the proto enum.
var publishVisibilities = map[string]v1.RepositoryVisibility{
	"public":   v1.RepositoryVisibility_REPOSITORY_VISIBILITY_PUBLIC,
	"internal": v1.RepositoryVisibility_REPOSITORY_VISIBILITY_INTERNAL,
	"private":  v1.RepositoryVisibility_REPOSITORY_VISIBILITY_PRIVATE,
}

// RegisterProjects registers repo.create, repo.github.publish and repo.delete. In the
// app, the Add Project dialog's New tab invokes repo.create (and repo.delete, confirmed,
// when the new project is cancelled), and repo.github.publish opens the publish dialog
// (its owner and visibility pickers); the CLI runs all three directly.
func RegisterProjects(r *Registry, d ProjectDeps) error {
	b := d.Backend
	if b == nil {
		b = codefoundryv1connect.UnimplementedRepoServiceHandler{}
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
			Name:  "repo.create",
			Title: "New Project",
			Description: "Start an empty project in ~/.code-foundry/projects/<name>: git init on the default branch " +
				"(init.defaultBranch, else main) and an empty initial commit. Refuses when that folder exists.",
			Category: "Project",
			Args: []ArgSpec{
				{Name: "name", Type: String, Required: true, Positional: true,
					Description: "Folder name: letters, digits, -, _ and . (not starting with .)"},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Create(ctx, connect.NewRequest(&v1.CreateRepoRequest{Name: a.String("name")}))
				if err != nil {
					return Result{}, err
				}
				repo := res.Msg.GetRepo()
				return Result{Message: "created " + repo.GetName() + " in " + repo.GetPath() + " (" + repo.GetId() + ")", JSON: repo}, nil
			},
		},
		Command{
			Name:  "repo.github.publish",
			Title: "Publish to GitHub",
			Description: "Create a GitHub repository for a git project without an origin remote and push it, with " +
				"`gh repo create <owner>/<name> --source <project> --remote origin --push`. Organizations may refuse " +
				"some visibilities; gh's error is shown as is.",
			Category: "Project",
			Args: []ArgSpec{
				{Name: "repo", Type: String, Required: true, Context: ContextRepo, Description: "Repository id"},
				{Name: "owner", Type: String, Required: true, Description: "GitHub user or organization"},
				{Name: "name", Type: String, Description: "Repository name on GitHub (default: the project's name)"},
				{Name: "visibility", Type: Enum, Required: true, Enum: []string{"public", "internal", "private"},
					Description: "Repository visibility"},
			},
			When: func(c Context) bool { return hasRepo(c) && !notGit(c) && !hasOrigin(c) },
			WhyUnavailable: func(c Context) string {
				if why := notGit.whyNotGit(c); why != "" {
					return why
				}
				if hasRepo(c) && hasOrigin(c) {
					return hasOriginReason
				}
				return ""
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				vis := a.String("visibility")
				res, err := b.Publish(ctx, connect.NewRequest(&v1.PublishRepoRequest{
					RepoId: a.String("repo"), Owner: a.String("owner"), Name: a.String("name"), Visibility: publishVisibilities[vis],
				}))
				if err != nil {
					return Result{}, err
				}
				repo := res.Msg.GetRepo()
				msg := "published " + repo.GetName()
				if slug := repo.GetGithubSlug(); slug != "" {
					msg += " to https://github.com/" + slug
				}
				msg += " (" + vis + ")"
				return Result{Message: msg, JSON: repo}, nil
			},
		},
		Command{
			Name:  "repo.delete",
			Title: "Delete Project",
			Description: "Stop tracking a project made by New Project and delete its folder in ~/.code-foundry/projects. " +
				"Only projects there can be deleted; a repository on GitHub is not touched.",
			Category: "Project",
			Args:     []ArgSpec{{Name: "repo", Type: String, Required: true, Context: ContextRepo, Description: "Repository id"}},
			When:     func(c Context) bool { return hasRepo(c) && deletable(c) },
			WhyUnavailable: func(c Context) string {
				if hasRepo(c) && !deletable(c) {
					return notDeletableReason
				}
				return ""
			},
			Confirm: "Delete project {repo} and its folder on disk? This cannot be undone.",
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("repo")
				if _, err := b.Delete(ctx, connect.NewRequest(&v1.DeleteRepoRequest{Id: id})); err != nil {
					return Result{}, err
				}
				return Result{Message: "deleted " + id}, nil
			},
		},
	)
}
