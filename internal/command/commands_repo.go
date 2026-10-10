package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// RepoBackend is the slice of RepoService the repo.* commands (and the pull request
// session commands, which list repositories) need, in generated Connect signatures (see
// TerminalBackend for why). The repo step's (1b) API handler, any
// RepoServiceHandler, and a RepoServiceClient satisfy it. Until it is wired,
// codefoundryv1connect.UnimplementedRepoServiceHandler stands in.
type RepoBackend interface {
	Register(context.Context, *connect.Request[v1.RegisterRepoRequest]) (*connect.Response[v1.RegisterRepoResponse], error)
	Unregister(context.Context, *connect.Request[v1.UnregisterRepoRequest]) (*connect.Response[v1.UnregisterRepoResponse], error)
	CreateWorktree(context.Context, *connect.Request[v1.CreateWorktreeRequest]) (*connect.Response[v1.CreateWorktreeResponse], error)
	RemoveWorktree(context.Context, *connect.Request[v1.RemoveWorktreeRequest]) (*connect.Response[v1.RemoveWorktreeResponse], error)
	Refresh(context.Context, *connect.Request[v1.RefreshRepoRequest]) (*connect.Response[v1.RefreshRepoResponse], error)
	List(context.Context, *connect.Request[v1.ListReposRequest]) (*connect.Response[v1.ListReposResponse], error)
	InitGit(context.Context, *connect.Request[v1.InitGitRequest]) (*connect.Response[v1.InitGitResponse], error)
}

var (
	_ RepoBackend = codefoundryv1connect.RepoServiceHandler(nil)
	_ RepoBackend = codefoundryv1connect.RepoServiceClient(nil)
)

func hasRepo(c Context) bool { return c.ActiveRepoID != "" }

func hasWorktree(c Context) bool { return c.ActiveRepoID != "" && c.ActiveWorktreePath != "" }

// NotGitFunc reports whether the context's worktree (else repo) belongs to a
// registered project that is not a git repository. Worktree, git and pull request
// commands are unavailable there; repo.git.init is available only there. A nil
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
	if (c.ActiveRepoID != "" || c.ActiveWorktreePath != "") && f(c) {
		return notGitReason
	}
	return ""
}

// RegisterRepo registers repo.register, repo.unregister, repo.worktree.new,
// repo.worktree.remove, repo.refresh and repo.git.init.
func RegisterRepo(r *Registry, b RepoBackend, notGit NotGitFunc) error {
	notGit = notGit.or()
	repoArg := ArgSpec{Name: "repo", Type: String, Required: true, Context: ContextRepo, Description: "Repository id"}
	return r.RegisterAll(
		Command{
			Name:        "repo.register",
			Title:       "Add Project (local folder)",
			Description: "Start tracking a folder as a project. A path inside a git repository adds that repository; any other folder is added as a project without git.",
			Category:    "Project",
			Args: []ArgSpec{
				{Name: "path", Type: Path, Required: true, Description: "Project folder (a git repository or any folder)"},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Register(ctx, connect.NewRequest(&v1.RegisterRepoRequest{Path: a.Path("path")}))
				if err != nil {
					return Result{}, err
				}
				repo := res.Msg.GetRepo()
				return Result{Message: "registered " + repo.GetName() + " (" + repo.GetId() + ")", JSON: repo}, nil
			},
		},
		Command{
			Name:        "repo.unregister",
			Title:       "Remove Project",
			Description: "Stop tracking a project (a registered repository). Nothing on disk is touched.",
			Category:    "Project",
			Args:        []ArgSpec{repoArg},
			When:        hasRepo,
			Confirm:     "Stop tracking project {repo}? Its threads lose their worktree; nothing on disk is touched.",
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("repo")
				if _, err := b.Unregister(ctx, connect.NewRequest(&v1.UnregisterRepoRequest{Id: id})); err != nil {
					return Result{}, err
				}
				return Result{Message: "unregistered " + id}, nil
			},
		},
		Command{
			Name:        "repo.worktree.new",
			Title:       "New Worktree",
			Description: "Create a worktree for a branch, creating the branch from base when it does not exist.",
			Category:    "Project",
			Args: []ArgSpec{
				repoArg,
				{Name: "branch", Type: String, Required: true, Description: "Branch to check out"},
				{Name: "base", Type: String, Description: "Ref to branch from (default: the default branch)"},
				{Name: "fetch", Type: Bool, Default: "true", Description: "Fetch the remote base branch first (bounded; a failed fetch uses the local copy)"},
			},
			When:           func(c Context) bool { return hasRepo(c) && !notGit(c) },
			WhyUnavailable: notGit.whyNotGit,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.CreateWorktree(ctx, connect.NewRequest(&v1.CreateWorktreeRequest{
					RepoId:  a.String("repo"),
					Branch:  a.String("branch"),
					BaseRef: a.String("base"),
					Fetch:   a.Bool("fetch"),
				}))
				if err != nil {
					return Result{}, err
				}
				wt := res.Msg.GetWorktree()
				return Result{Message: "created worktree " + wt.GetPath() + " on " + wt.GetBranch(), JSON: wt}, nil
			},
		},
		Command{
			Name:        "repo.worktree.remove",
			Title:       "Remove Worktree",
			Description: "Remove a worktree from disk, optionally deleting its branch.",
			Category:    "Project",
			Args: []ArgSpec{
				repoArg,
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
					RepoId:       a.String("repo"),
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
			Name:        "repo.refresh",
			Title:       "Refresh Project Status",
			Description: "Re-read git status now, for one project or all of them.",
			Category:    "Project",
			Args: []ArgSpec{
				{Name: "repo", Type: String, Context: ContextRepo, Description: "Repository id (default: all)"},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("repo")
				if _, err := b.Refresh(ctx, connect.NewRequest(&v1.RefreshRepoRequest{Id: id})); err != nil {
					return Result{}, err
				}
				if id == "" {
					return Result{Message: "refreshed all repositories"}, nil
				}
				return Result{Message: "refreshed " + id}, nil
			},
		},
		gitInitCommand(b, repoArg, notGit),
	)
}
