package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// RepoBackend is the slice of RepoService the repo.* commands (and the pull request
// thread commands, which list repositories) need, in generated Connect signatures (see
// TerminalBackend for why). The repo step's (1b) API handler, any
// RepoServiceHandler, and a RepoServiceClient satisfy it. Until it is wired,
// codefoundryv1connect.UnimplementedRepoServiceHandler stands in.
type ProjectBackend interface {
	Register(context.Context, *connect.Request[v1.RegisterProjectRequest]) (*connect.Response[v1.RegisterProjectResponse], error)
	Unregister(context.Context, *connect.Request[v1.UnregisterProjectRequest]) (*connect.Response[v1.UnregisterProjectResponse], error)
	CreateWorktree(context.Context, *connect.Request[v1.CreateWorktreeRequest]) (*connect.Response[v1.CreateWorktreeResponse], error)
	RemoveWorktree(context.Context, *connect.Request[v1.RemoveWorktreeRequest]) (*connect.Response[v1.RemoveWorktreeResponse], error)
	CleanupWorktrees(context.Context, *connect.Request[v1.CleanupWorktreesRequest]) (*connect.Response[v1.CleanupWorktreesResponse], error)
	Refresh(context.Context, *connect.Request[v1.RefreshProjectRequest]) (*connect.Response[v1.RefreshProjectResponse], error)
	List(context.Context, *connect.Request[v1.ListProjectsRequest]) (*connect.Response[v1.ListProjectsResponse], error)
	InitGit(context.Context, *connect.Request[v1.InitGitRequest]) (*connect.Response[v1.InitGitResponse], error)
}

var (
	_ ProjectBackend = codefoundryv1connect.ProjectServiceHandler(nil)
	_ ProjectBackend = codefoundryv1connect.ProjectServiceClient(nil)
)

func hasProject(c Context) bool { return c.ActiveProjectID != "" }

func hasWorktree(c Context) bool { return c.ActiveProjectID != "" && c.ActiveWorktreePath != "" }

// NotGitFunc reports whether the context's worktree (else repo) belongs to a
// registered project that is not a git repository. Worktree, git and pull request
// commands are unavailable there; project.git.init is available only there. A nil
// NotGitFunc means never (every project is git).
type NotGitFunc func(Context) bool

// notGitReason is why git commands are unavailable in a project without git.
const notGitReason = "project is not a git repository"

func (f NotGitFunc) or() NotGitFunc {
	if f == nil {
		return func(Context) bool { return false }
	}
	return f
}

// whyNotGit explains an unavailable git command once a project is known.
func (f NotGitFunc) whyNotGit(c Context) string {
	if (c.ActiveProjectID != "" || c.ActiveWorktreePath != "") && f(c) {
		return notGitReason
	}
	return ""
}

// RegisterRepo registers project.unregister, project.worktree.new, project.worktree.remove,
// project.refresh and project.git.init. Adding a project is project.add (commands_repo_add.go).
func RegisterProject(r *Registry, b ProjectBackend, notGit NotGitFunc) error {
	notGit = notGit.or()
	projectArg := ArgSpec{Name: "project", Type: String, Required: true, Context: ContextProject, Description: "Project id"}
	return r.RegisterAll(
		Command{
			Name:        "project.unregister",
			Title:       "Remove Project",
			Description: "Stop tracking a project. Nothing on disk is touched.",
			Category:    "Project",
			Args:        []ArgSpec{projectArg},
			When:        hasProject,
			Confirm:     "Stop tracking project {project}? Its threads lose their worktree; nothing on disk is touched.",
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("project")
				if _, err := b.Unregister(ctx, connect.NewRequest(&v1.UnregisterProjectRequest{Id: id})); err != nil {
					return Result{}, err
				}
				return Result{Message: "unregistered " + id}, nil
			},
		},
		Command{
			Name:        "project.worktree.new",
			Title:       "New Worktree",
			Description: "Create a worktree for a branch, creating the branch from base when it does not exist.",
			Category:    "Project",
			Args: []ArgSpec{
				projectArg,
				{Name: "branch", Type: String, Required: true, Description: "Branch to check out"},
				{Name: "base", Type: String, Description: "Ref to branch from (default: the default branch)"},
				{Name: "fetch", Type: Bool, Default: "true", Description: "Fetch the remote base branch first (bounded; a failed fetch uses the local copy)"},
			},
			When:           func(c Context) bool { return hasProject(c) && !notGit(c) },
			WhyUnavailable: notGit.whyNotGit,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.CreateWorktree(ctx, connect.NewRequest(&v1.CreateWorktreeRequest{
					ProjectId: a.String("project"),
					Branch:    a.String("branch"),
					BaseRef:   a.String("base"),
					Fetch:     a.Bool("fetch"),
				}))
				if err != nil {
					return Result{}, err
				}
				wt := res.Msg.GetWorktree()
				return Result{Message: "created worktree " + wt.GetPath() + " on " + wt.GetBranch(), JSON: wt}, nil
			},
		},
		Command{
			Name:        "project.worktree.remove",
			Title:       "Remove Worktree",
			Description: "Remove a worktree from disk, optionally deleting its branch.",
			Category:    "Project",
			Args: []ArgSpec{
				projectArg,
				{Name: "path", Type: Path, Required: true, Context: ContextWorktree, Description: "Worktree path"},
				{Name: "delete-branch", Type: Bool, Description: "Also delete the branch"},
				{Name: "force", Type: Bool, Description: "Remove even with uncommitted changes"},
			},
			When:           func(c Context) bool { return hasWorktree(c) && !notGit(c) },
			WhyUnavailable: notGit.whyNotGit,
			Confirm:        "Remove worktree {path}? This deletes files on disk.",
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				path := a.Path("path")
				if _, err := b.RemoveWorktree(ctx, connect.NewRequest(&v1.RemoveWorktreeRequest{
					ProjectId:    a.String("project"),
					Path:         path,
					DeleteBranch: a.Bool("delete-branch"),
					Force:        a.Bool("force"),
				})); err != nil {
					return Result{}, err
				}
				return Result{Message: "removed worktree " + path}, nil
			},
		},
		Command{
			Name:        "project.refresh",
			Title:       "Refresh Project Status",
			Description: "Re-read git status now, for one project or all of them.",
			Category:    "Project",
			Args: []ArgSpec{
				{Name: "project", Type: String, Context: ContextProject, Description: "Project id (default: all)"},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("project")
				if _, err := b.Refresh(ctx, connect.NewRequest(&v1.RefreshProjectRequest{Id: id})); err != nil {
					return Result{}, err
				}
				if id == "" {
					return Result{Message: "refreshed all projects"}, nil
				}
				return Result{Message: "refreshed " + id}, nil
			},
		},
		gitInitCommand(b, projectArg, notGit),
	)
}
