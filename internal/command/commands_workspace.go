package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// WorkspaceBackend is the slice of WorkspaceService the workspace.* commands need, in
// generated Connect signatures (see TerminalBackend for why).
type WorkspaceBackend interface {
	List(context.Context, *connect.Request[v1.ListWorkspacesRequest]) (*connect.Response[v1.ListWorkspacesResponse], error)
	Create(context.Context, *connect.Request[v1.CreateWorkspaceRequest]) (*connect.Response[v1.CreateWorkspaceResponse], error)
	AddProject(context.Context, *connect.Request[v1.AddWorkspaceProjectRequest]) (*connect.Response[v1.AddWorkspaceProjectResponse], error)
	RemoveProject(context.Context, *connect.Request[v1.RemoveWorkspaceProjectRequest]) (*connect.Response[v1.RemoveWorkspaceProjectResponse], error)
	Rename(context.Context, *connect.Request[v1.RenameWorkspaceRequest]) (*connect.Response[v1.RenameWorkspaceResponse], error)
	SetDefaultPrimary(context.Context, *connect.Request[v1.SetWorkspaceDefaultPrimaryRequest]) (*connect.Response[v1.SetWorkspaceDefaultPrimaryResponse], error)
	Remove(context.Context, *connect.Request[v1.RemoveWorkspaceRequest]) (*connect.Response[v1.RemoveWorkspaceResponse], error)
}

var (
	_ WorkspaceBackend = codefoundryv1connect.WorkspaceServiceHandler(nil)
	_ WorkspaceBackend = codefoundryv1connect.WorkspaceServiceClient(nil)
)

// RegisterWorkspace registers workspace.new, workspace.list, workspace.add-project,
// workspace.remove-project, workspace.rename, workspace.set-primary and workspace.remove
// (docs/notes/workspaces-v2-2-workspaces.md). A workspace is a saved set of projects
// with a managed dir for the instructions and skills that span them; it has no branch
// and no worktrees (a thread's project set and branch decide those).
func RegisterWorkspace(r *Registry, b WorkspaceBackend) error {
	// A workspace is named by id or name, else the active one (the GUI's, or
	// --context-workspace).
	wsArg := ArgSpec{Name: "workspace", Type: String, Description: "Workspace id or name (default: the active workspace)"}
	ws := func(c Context, a Args) (string, error) {
		if w := strings.TrimSpace(a.String("workspace")); w != "" {
			return w, nil
		}
		if c.ActiveWorkspaceID != "" {
			return c.ActiveWorkspaceID, nil
		}
		return "", InvalidArg("workspace", "name the workspace (an id or a name)")
	}
	return r.RegisterAll(
		Command{
			Name:  "workspace.new",
			Title: "New Workspace",
			Description: "Save a set of projects as a workspace, with a folder of its own for the instructions and skills that span them " +
				"(with root: links to the root's CLAUDE.md, AGENTS.md and .claude). Nothing else is created.",
			Category: "Workspace",
			Args: []ArgSpec{
				{Name: "name", Type: String, Required: true, Positional: true, Description: "Workspace name"},
				{Name: "projects", Type: String, Description: "Comma-separated projects (id, name, or absolute path)"},
				{Name: "root", Type: Path, Description: "A folder the workspace comes from (its CLAUDE.md, AGENTS.md and .claude reach its threads)"},
				{Name: "primary", Type: String, Description: "Where new threads start: a project, or workspace (its folder) (default: workspace with root, else the first project)"},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				req := &v1.CreateWorkspaceRequest{Name: a.String("name"), Members: splitList(a.String("projects")),
					RootPath: a.Path("root"), DefaultPrimary: a.String("primary")}
				if len(req.Members) == 0 && req.RootPath == "" {
					return Result{}, InvalidArg("projects", "argument \"projects\": name at least one project (or a root)")
				}
				res, err := b.Create(ctx, connect.NewRequest(req))
				if err != nil {
					return Result{}, err
				}
				w := res.Msg.GetWorkspace()
				return Result{Message: "created workspace " + describeWorkspace(w), JSON: w}, nil
			},
		},
		Command{
			Name:         "workspace.list",
			ReadOnly:     true,
			Title:        "List Workspaces",
			Description:  "List workspaces with their projects, default primary and folder.",
			Category:     "Workspace",
			NoKeybinding: true,
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
			Name:        "workspace.add-project",
			Title:       "Add Project to Workspace",
			Description: "Add a project to a workspace. Nothing on disk changes.",
			Category:    "Workspace",
			Args: []ArgSpec{
				{Name: "project", Type: String, Required: true, Positional: true, Description: "Project id, name, or absolute path"},
				wsArg,
			},
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				w, err := ws(c, a)
				if err != nil {
					return Result{}, err
				}
				res, err := b.AddProject(ctx, connect.NewRequest(&v1.AddWorkspaceProjectRequest{Workspace: w, Project: a.String("project")}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "added " + a.String("project") + " to workspace " + describeWorkspace(res.Msg.GetWorkspace()), JSON: res.Msg.GetWorkspace()}, nil
			},
		},
		Command{
			Name:        "workspace.remove-project",
			Title:       "Remove Project from Workspace",
			Description: "Drop a project from a workspace. Nothing on disk changes; threads keep their projects.",
			Category:    "Workspace",
			Args: []ArgSpec{
				{Name: "project", Type: String, Required: true, Positional: true, Description: "Project id or name"},
				wsArg,
			},
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				w, err := ws(c, a)
				if err != nil {
					return Result{}, err
				}
				res, err := b.RemoveProject(ctx, connect.NewRequest(&v1.RemoveWorkspaceProjectRequest{Workspace: w, Project: a.String("project")}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "removed " + a.String("project") + " from workspace " + describeWorkspace(res.Msg.GetWorkspace()), JSON: res.Msg.GetWorkspace()}, nil
			},
		},
		Command{
			Name:        "workspace.rename",
			Title:       "Rename Workspace",
			Description: "Rename a workspace (names are unique, whatever their case).",
			Category:    "Workspace",
			Args: []ArgSpec{
				{Name: "name", Type: String, Required: true, Positional: true, Description: "New name"},
				wsArg,
			},
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				w, err := ws(c, a)
				if err != nil {
					return Result{}, err
				}
				res, err := b.Rename(ctx, connect.NewRequest(&v1.RenameWorkspaceRequest{Workspace: w, Name: a.String("name")}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "renamed workspace " + describeWorkspace(res.Msg.GetWorkspace()), JSON: res.Msg.GetWorkspace()}, nil
			},
		},
		Command{
			Name:        "workspace.set-primary",
			Title:       "Set Workspace Default Primary",
			Description: "Set where new threads in a workspace start: one of its projects, or workspace (its folder).",
			Category:    "Workspace",
			Args: []ArgSpec{
				{Name: "primary", Type: String, Required: true, Positional: true, Description: "A project of the workspace (id or name), or workspace"},
				wsArg,
			},
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				w, err := ws(c, a)
				if err != nil {
					return Result{}, err
				}
				res, err := b.SetDefaultPrimary(ctx, connect.NewRequest(&v1.SetWorkspaceDefaultPrimaryRequest{Workspace: w, DefaultPrimary: a.String("primary")}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "workspace " + describeWorkspace(res.Msg.GetWorkspace()), JSON: res.Msg.GetWorkspace()}, nil
			},
		},
		Command{
			Name:  "workspace.remove",
			Title: "Remove Workspace",
			Description: "Forget a workspace. Its folder goes with its instructions and skills; for a workspace with a root, only the links " +
				"(the root is yours). Projects, worktrees and threads stay.",
			Category: "Workspace",
			Args: []ArgSpec{
				{Name: "workspace", Type: String, Required: true, Positional: true, Description: "Workspace id or name"},
			},
			Confirm: "Remove workspace {workspace}? Its instructions and skills are deleted too (a workspace with a root keeps the root's).",
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				w := a.String("workspace")
				if _, err := b.Remove(ctx, connect.NewRequest(&v1.RemoveWorkspaceRequest{Workspace: w})); err != nil {
					return Result{}, err
				}
				return Result{Message: "removed workspace " + w}, nil
			},
		},
	)
}

func withPositional(s ArgSpec) ArgSpec {
	s.Positional = true
	return s
}

// describeWorkspace is "shop (w-…): 2 projects (api, web), starts in api, folder /…".
func describeWorkspace(w *v1.Workspace) string {
	n := len(w.GetMembers())
	noun := "projects"
	if n == 1 {
		noun = "project"
	}
	s := fmt.Sprintf("%s (%s): %d %s", w.GetName(), w.GetId(), n, noun)
	if n > 0 {
		s += " (" + strings.Join(w.GetMembers(), ", ") + ")"
	}
	if p := w.GetDefaultPrimary(); p != "" {
		s += ", starts in " + p
	}
	if r := w.GetRootPath(); r != "" {
		s += ", root " + r
	}
	return s + ", folder " + w.GetManagedDir()
}
