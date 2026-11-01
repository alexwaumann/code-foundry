package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// ProjectBackend is the slice of ProjectService the project.* commands (and the pull request
// thread commands, which list repositories) need, in generated Connect signatures (see
// TerminalBackend for why). The repo step's (1b) API handler, any
// ProjectServiceHandler, and a ProjectServiceClient satisfy it. Until it is wired,
// codefoundryv1connect.UnimplementedProjectServiceHandler stands in.
type ProjectBackend interface {
	Register(context.Context, *connect.Request[v1.RegisterProjectRequest]) (*connect.Response[v1.RegisterProjectResponse], error)
	InspectFolder(context.Context, *connect.Request[v1.InspectFolderRequest]) (*connect.Response[v1.InspectFolderResponse], error)
	Unregister(context.Context, *connect.Request[v1.UnregisterProjectRequest]) (*connect.Response[v1.UnregisterProjectResponse], error)
	CreateWorktree(context.Context, *connect.Request[v1.CreateWorktreeRequest]) (*connect.Response[v1.CreateWorktreeResponse], error)
	RemoveWorktree(context.Context, *connect.Request[v1.RemoveWorktreeRequest]) (*connect.Response[v1.RemoveWorktreeResponse], error)
	DeleteBranch(context.Context, *connect.Request[v1.DeleteBranchRequest]) (*connect.Response[v1.DeleteBranchResponse], error)
	CleanupWorktrees(context.Context, *connect.Request[v1.CleanupWorktreesRequest]) (*connect.Response[v1.CleanupWorktreesResponse], error)
	Refresh(context.Context, *connect.Request[v1.RefreshProjectRequest]) (*connect.Response[v1.RefreshProjectResponse], error)
	List(context.Context, *connect.Request[v1.ListProjectsRequest]) (*connect.Response[v1.ListProjectsResponse], error)
	InitGit(context.Context, *connect.Request[v1.InitGitRequest]) (*connect.Response[v1.InitGitResponse], error)
	Rename(context.Context, *connect.Request[v1.RenameProjectRequest]) (*connect.Response[v1.RenameProjectResponse], error)
}

var (
	_ ProjectBackend = codefoundryv1connect.ProjectServiceHandler(nil)
	_ ProjectBackend = codefoundryv1connect.ProjectServiceClient(nil)
)

func hasProject(c Context) bool { return c.ActiveProjectID != "" }

func hasWorktree(c Context) bool { return c.ActiveProjectID != "" && c.ActiveWorktreePath != "" }

// NotGitFunc reports whether the context's worktree (else project) belongs to a
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

// RegisterProject registers project.list, project.unregister, project.worktree.new, project.worktree.remove,
// project.branch.delete, project.refresh, project.git.init and project.rename. Adding a project is project.add
// (commands_project_add.go).
func RegisterProject(r *Registry, b ProjectBackend, notGit NotGitFunc) error {
	notGit = notGit.or()
	projectArg := ArgSpec{Name: "project", Type: String, Required: true, Context: ContextProject, ID: ProjectID, Description: ProjectRefHelp}
	r.SetRefResolver(ProjectID, func(ctx context.Context, _, ref string) (string, error) { return projectRef(ctx, b, ref, false) })
	r.SetProjectNames(func(ctx context.Context) (map[string]string, error) {
		res, err := b.List(ctx, connect.NewRequest(&v1.ListProjectsRequest{}))
		if err != nil {
			return nil, err
		}
		names := make(map[string]string, len(res.Msg.GetProjects()))
		for _, p := range res.Msg.GetProjects() {
			names[p.GetId()] = p.GetName()
		}
		return names, nil
	})
	return r.RegisterAll(
		Command{
			Name:         "project.list",
			NoPalette:    true,
			ReadOnly:     true,
			Title:        "List Projects",
			Description:  "List registered projects: name, id and path, one per line. --project and the other project commands take the id or the name.",
			Category:     "Project",
			NoKeybinding: true,
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := b.List(ctx, connect.NewRequest(&v1.ListProjectsRequest{}))
				if err != nil {
					return Result{}, err
				}
				ps := res.Msg.GetProjects()
				if len(ps) == 0 {
					return Result{Message: "no projects", JSON: res.Msg}, nil
				}
				lines := make([]string, len(ps))
				for i, p := range ps {
					lines[i] = fmt.Sprintf("%s (%s) %s", p.GetName(), p.GetId(), p.GetPath())
					if !p.GetGit() {
						lines[i] += " (no git)"
					}
				}
				return Result{Message: strings.Join(lines, "\n"), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:        "project.unregister",
			Title:       "Remove Project",
			Description: "Stop tracking a project. The worktrees Code Foundry made for it that no thread uses and that are clean are removed (never a branch); nothing else on disk is touched.",
			Category:    "Project",
			Args:        []ArgSpec{projectArg},
			When:        hasProject,
			Confirm:     "Stop tracking project {project}? Its threads lose their worktree; clean worktrees Code Foundry made that no thread uses are removed (branches stay).",
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
				{Name: "base", Type: String, Description: "Ref to branch from (default: the default branch; a branch name means origin's copy, fetched, unless the local branch is ahead of it; the local branch with base-from-origin no or projects.base_from_origin off)"},
				{Name: "fetch", Type: Bool, Default: "true", Description: "Fetch the remote base branch first (bounded; a failed fetch uses the local copy; never with base-from-origin no or projects.base_from_origin off)"},
				baseFromOriginArg,
			},
			When:           func(c Context) bool { return hasProject(c) && !notGit(c) },
			WhyUnavailable: notGit.whyNotGit,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				fromOrigin, err := baseFromOrigin(a)
				if err != nil {
					return Result{}, err
				}
				res, err := b.CreateWorktree(ctx, connect.NewRequest(&v1.CreateWorktreeRequest{
					ProjectId:      a.String("project"),
					Branch:         a.String("branch"),
					BaseRef:        a.String("base"),
					Fetch:          a.Bool("fetch"),
					BaseFromOrigin: fromOrigin,
				}))
				if err != nil {
					return Result{}, err
				}
				wt := res.Msg.GetWorktree()
				return Result{Message: "created worktree " + wt.GetPath() + " on " + wt.GetBranch(), JSON: wt}, nil
			},
		},
		Command{
			Name:  "project.worktree.remove",
			Title: "Remove Worktree",
			Description: "Remove a worktree from disk, optionally deleting its branch (only when merged into the default branch; " +
				"an unmerged one is kept and the command says so). Refused while a thread is on it, a terminal is open in it or a " +
				"workspace has it; --force removes it anyway and deletes an unmerged branch." + forceNote,
			Category: "Project",
			Args: []ArgSpec{
				{Name: "project", Type: String, Context: ContextProject, ID: ProjectID, Description: ProjectRefHelp + " (default: the project the worktree is registered in)"},
				{Name: "path", Type: Path, Required: true, Context: ContextWorktree, Description: "Worktree path"},
				{Name: "delete-branch", Type: Bool, Description: "Also delete the branch when it is merged into the default branch (with --force: always)"},
				{Name: "force", Type: Bool, Description: "Remove even with uncommitted changes, deleting them (without it: asked), or while a thread, terminal or workspace uses it; with --delete-branch, delete an unmerged branch too"},
			},
			// The project may be left out: the path names it (W4 finding 2: inside a
			// thread, --path alone was "not available in this context").
			When:           func(c Context) bool { return hasActiveWorktree(c) && !notGit(c) },
			WhyUnavailable: whyNoWorktree(notGit),
			Confirm:        "Remove worktree {path}? This deletes files on disk.",
			DynamicConfirm: func(_ context.Context, _ Context, a Args) string {
				if !a.Bool("delete-branch") || a.Bool("force") {
					return ""
				}
				return "Remove worktree " + a.Path("path") + " and delete its branch? This deletes files on disk. " +
					"A branch with commits not in the default branch is kept."
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				path := a.Path("path")
				project, err := worktreeProject(ctx, b, a.String("project"), path)
				if err != nil {
					return Result{}, err
				}
				if _, err := b.RemoveWorktree(ctx, connect.NewRequest(&v1.RemoveWorktreeRequest{
					ProjectId:    project,
					Path:         path,
					DeleteBranch: a.Bool("delete-branch"),
					Force:        a.Bool("force"),
				})); err != nil {
					if wts := uncommittedOf(err); wts != nil && !a.Bool("force") {
						return Result{}, deleteWorkConfirm("project.worktree.remove", wts, withBranch(a, "the worktree"))
					}
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
				{Name: "project", Type: String, Context: ContextProject, ID: ProjectID, Description: ProjectRefHelp + " (default: all)"},
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
		branchDeleteCommand(b, notGit),
		renameCommand(b, projectArg),
	)
}
