package command

import (
	"context"
	"fmt"
	"strings"
	"text/tabwriter"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// WorkspaceBackend is the slice of WorkspaceService the workspace.* commands need, in
// generated Connect signatures (see TerminalBackend for why).
type WorkspaceBackend interface {
	List(context.Context, *connect.Request[v1.ListWorkspacesRequest]) (*connect.Response[v1.ListWorkspacesResponse], error)
	Create(context.Context, *connect.Request[v1.CreateWorkspaceRequest]) (*connect.Response[v1.CreateWorkspaceResponse], error)
	AddRepo(context.Context, *connect.Request[v1.AddWorkspaceRepoRequest]) (*connect.Response[v1.AddWorkspaceRepoResponse], error)
	RemoveRepo(context.Context, *connect.Request[v1.RemoveWorkspaceRepoRequest]) (*connect.Response[v1.RemoveWorkspaceRepoResponse], error)
	Remove(context.Context, *connect.Request[v1.RemoveWorkspaceRequest]) (*connect.Response[v1.RemoveWorkspaceResponse], error)
	Members(context.Context, *connect.Request[v1.WorkspaceMembersRequest]) (*connect.Response[v1.WorkspaceMembersResponse], error)
}

var (
	_ WorkspaceBackend = codefoundryv1connect.WorkspaceServiceHandler(nil)
	_ WorkspaceBackend = codefoundryv1connect.WorkspaceServiceClient(nil)
)

// RegisterWorkspace registers workspace.new, workspace.list, workspace.members,
// workspace.add-repo, workspace.remove-repo and workspace.remove.
func RegisterWorkspace(r *Registry, b WorkspaceBackend) error {
	// A workspace is named by id or name, else found from a path inside one of its
	// member worktrees: the CLI's working directory, or the GUI's active worktree.
	wsArg := ArgSpec{Name: "workspace", Type: String, Description: "Workspace id or name (default: the workspace whose worktree contains --cwd)"}
	cwdArg := ArgSpec{
		Name: "cwd", Type: Path, Context: ContextWorktree, DefaultToCwd: true,
		Description: "A path inside a member worktree, used to find the workspace when none is named (CLI default: the working directory)",
	}
	fetchArg := ArgSpec{Name: "fetch", Type: Bool, Default: "true", Description: "Fetch each remote base branch first (bounded; a failed fetch uses the local copy)"}
	return r.RegisterAll(
		Command{
			Name:  "workspace.new",
			Title: "New Workspace",
			Description: "Create a workspace: one branch checked out as a new worktree in each of several repositories. " +
				"Nothing is created unless every worktree can be.",
			Category: "Workspace",
			Args: []ArgSpec{
				{Name: "name", Type: String, Required: true, Positional: true, Description: "Workspace name"},
				{Name: "repos", Type: String, Required: true, Description: "Comma-separated repositories (id, name, or absolute path), each optionally repo:base-ref"},
				{Name: "branch", Type: String, Description: "Branch for every worktree (default: cf/<name as a slug>)"},
				{Name: "base", Type: String, Description: "Ref to branch from for repositories without their own (default: origin/<default branch>)"},
				fetchArg,
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				req := &v1.CreateWorkspaceRequest{
					Name: a.String("name"), Branch: a.String("branch"), BaseRef: a.String("base"), Fetch: a.Bool("fetch"),
				}
				for _, item := range splitList(a.String("repos")) {
					repo, base, _ := strings.Cut(item, ":")
					req.Members = append(req.Members, &v1.WorkspaceMemberSpec{Repo: strings.TrimSpace(repo), BaseRef: strings.TrimSpace(base)})
				}
				if len(req.Members) == 0 {
					return Result{}, InvalidArg("repos", "argument \"repos\": name at least one repository")
				}
				res, err := b.Create(ctx, connect.NewRequest(req))
				if err != nil {
					return Result{}, err
				}
				w := res.Msg.GetWorkspace()
				msg := "created workspace " + describeWorkspace(w)
				if ms, err := b.Members(ctx, connect.NewRequest(&v1.WorkspaceMembersRequest{Workspace: w.GetId()})); err == nil {
					msg = "created " + formatMembers(ms.Msg)
				}
				return Result{Message: msg, JSON: w}, nil
			},
		},
		Command{
			Name:        "workspace.list",
			Title:       "List Workspaces",
			Description: "List workspaces with their branch and member repositories.",
			Category:    "Workspace",
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := b.List(ctx, connect.NewRequest(&v1.ListWorkspacesRequest{}))
				if err != nil {
					return Result{}, err
				}
				ws := res.Msg.GetWorkspaces()
				if len(ws) == 0 {
					return Result{Message: "no workspaces", JSON: res.Msg}, nil
				}
				lines := make([]string, len(ws))
				for i, w := range ws {
					lines[i] = describeWorkspace(w)
				}
				return Result{Message: strings.Join(lines, "\n"), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:  "workspace.members",
			Title: "Workspace Members",
			Description: "List a workspace's worktrees: one line per member repository with its worktree path and branch. " +
				"Without a workspace, the one whose worktree contains --cwd (the working directory) is used.",
			Category: "Workspace",
			Args:     []ArgSpec{withPositional(wsArg), cwdArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Members(ctx, connect.NewRequest(&v1.WorkspaceMembersRequest{
					Workspace: a.String("workspace"), Cwd: a.Path("cwd"),
				}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: formatMembers(res.Msg), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:        "workspace.add-repo",
			Title:       "Add Project to Workspace",
			Description: "Create a worktree on the workspace branch in another project (repository) and add it to the workspace.",
			Category:    "Workspace",
			Args: []ArgSpec{
				{Name: "repo", Type: String, Required: true, Positional: true, Description: "Repository id, name, or absolute path"},
				wsArg, cwdArg,
				{Name: "base", Type: String, Description: "Ref to branch from when the branch does not exist (default: origin/<default branch>)"},
				fetchArg,
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.AddRepo(ctx, connect.NewRequest(&v1.AddWorkspaceRepoRequest{
					Workspace: a.String("workspace"), Cwd: a.Path("cwd"), Repo: a.String("repo"),
					BaseRef: a.String("base"), Fetch: a.Bool("fetch"),
				}))
				if err != nil {
					return Result{}, err
				}
				w := res.Msg.GetWorkspace()
				msg := "added " + a.String("repo") + " to workspace " + w.GetName()
				if ms := w.GetMembers(); len(ms) > 0 {
					msg += ": " + ms[len(ms)-1].GetWorktreePath() + " on " + w.GetBranch()
				}
				return Result{Message: msg, JSON: w}, nil
			},
		},
		Command{
			Name:  "workspace.remove-repo",
			Title: "Remove Project from Workspace",
			Description: "Delete a member repository's worktree and drop it from the workspace. Refused while a thread runs " +
				"in that worktree, and when it has uncommitted changes unless --force.",
			Category: "Workspace",
			Args: []ArgSpec{
				{Name: "repo", Type: String, Required: true, Positional: true, Description: "Repository id, name, or path (the member worktree path works too)"},
				wsArg, cwdArg,
				{Name: "force", Type: Bool, Description: "Remove even with uncommitted changes"},
				{Name: "delete-branch", Type: Bool, Description: "Also delete the branch"},
			},
			Confirm: "Remove project {repo} from its workspace? This deletes its worktree from disk.",
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.RemoveRepo(ctx, connect.NewRequest(&v1.RemoveWorkspaceRepoRequest{
					Workspace: a.String("workspace"), Cwd: a.Path("cwd"), Repo: a.String("repo"),
					Force: a.Bool("force"), DeleteBranch: a.Bool("delete-branch"),
				}))
				if err != nil {
					return Result{}, err
				}
				w := res.Msg.GetWorkspace()
				return Result{Message: fmt.Sprintf("removed %s from workspace %s (%d left)", a.String("repo"), w.GetName(), len(w.GetMembers())), JSON: w}, nil
			},
		},
		Command{
			Name:  "workspace.remove",
			Title: "Remove Workspace",
			Description: "Delete every member worktree and forget the workspace. Refused while a thread runs in any member " +
				"worktree, and when any has uncommitted changes unless --force; nothing is removed then.",
			Category: "Workspace",
			Args: []ArgSpec{
				{Name: "workspace", Type: String, Required: true, Positional: true, Description: "Workspace id or name"},
				{Name: "force", Type: Bool, Description: "Remove even with uncommitted changes"},
				{Name: "delete-branch", Type: Bool, Description: "Also delete each member's branch"},
			},
			Confirm: "Remove workspace {workspace}? This deletes every member worktree from disk.",
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				ws := a.String("workspace")
				if _, err := b.Remove(ctx, connect.NewRequest(&v1.RemoveWorkspaceRequest{
					Workspace: ws, Force: a.Bool("force"), DeleteBranch: a.Bool("delete-branch"),
				})); err != nil {
					return Result{}, err
				}
				return Result{Message: "removed workspace " + ws}, nil
			},
		},
	)
}

func withPositional(s ArgSpec) ArgSpec {
	s.Positional = true
	return s
}

// describeWorkspace is "login (w-…) on cf/login, 2 repositories".
func describeWorkspace(w *v1.Workspace) string {
	n := len(w.GetMembers())
	noun := "repositories"
	if n == 1 {
		noun = "repository"
	}
	return fmt.Sprintf("%s (%s) on %s, %d %s", w.GetName(), w.GetId(), w.GetBranch(), n, noun)
}

// formatMembers renders a membership for people and for Claude: a header line, then
// one aligned line per member with repository name, id, worktree path and branch.
func formatMembers(m *v1.WorkspaceMembersResponse) string {
	var b strings.Builder
	w := m.GetWorkspace()
	fmt.Fprintf(&b, "workspace %s (%s), branch %s\n", w.GetName(), w.GetId(), w.GetBranch())
	if len(m.GetMembers()) == 0 {
		b.WriteString("no member repositories")
		return b.String()
	}
	tw := tabwriter.NewWriter(&b, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "REPO\tID\tWORKTREE\tBRANCH")
	for _, mem := range m.GetMembers() {
		branch := mem.GetBranch()
		if mem.GetCurrent() {
			branch += " (current)"
		}
		if mem.GetMissing() {
			branch += " (missing)"
		}
		name := mem.GetRepoName()
		if name == "" {
			name = "?"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", name, mem.GetRepoId(), mem.GetWorktreePath(), branch)
	}
	_ = tw.Flush()
	return strings.TrimRight(b.String(), "\n")
}
