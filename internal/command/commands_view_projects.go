package command

import (
	"context"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// WorkspaceLister lists the workspaces (WorkspaceService.List): view.projects --workspace
// resolves its ref through it.
type WorkspaceLister interface {
	List(context.Context, *connect.Request[v1.ListWorkspacesRequest]) (*connect.Response[v1.ListWorkspacesResponse], error)
}

// The Projects tab's params on one page: the project's or the workspace's id.
const (
	ViewProjectsProjectParam   = "project"
	ViewProjectsWorkspaceParam = "workspace"
)

// projectsCommand is view.projects: the Projects page (the index, or the page the window
// showed last there), or one project's or workspace's page with --project or --workspace
// (the thread header's crumb opens its place this way; docs/notes/thread-crumb-links.md).
func (d ViewDeps) projectsCommand() Command {
	return Command{
		Name:  "view.projects",
		Page:  PageState,
		Title: "Show Projects",
		Description: "Show the Projects page, its tab in the current space: each project's worktrees and each workspace's members, with their git state and actions; " +
			"--project or --workspace opens that one's page.",
		Category: "View",
		// No default chord since the shell: cmd+shift+j is terminal.cycle (docs/notes/shell-model.md, "Keys").
		Args: []ArgSpec{
			pageFocusArg,
			// No Context: without one, the palette and a pane's + show the index.
			{Name: ViewProjectsProjectParam, Type: String, ID: ProjectID, Description: "Open this project's page: " + ProjectRefHelp},
			{Name: ViewProjectsWorkspaceParam, Type: String, Description: "Open this workspace's page: its id or name"},
			openPaneArg,
		},
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			project, ws := a.String(ViewProjectsProjectParam), strings.TrimSpace(a.String(ViewProjectsWorkspaceParam))
			switch {
			case project != "" && ws != "":
				return Result{}, InvalidArg(ViewProjectsWorkspaceParam, "give --project or --workspace, not both")
			case project != "":
				return d.showPageTab(ctx, uctx, a, tabProjs, map[string]string{ViewProjectsProjectParam: project})
			case ws != "":
				if d.Workspaces == nil {
					return d.showPageTab(ctx, uctx, a, tabProjs, map[string]string{ViewProjectsWorkspaceParam: ws})
				}
				w, err := findWorkspace(ctx, d.Workspaces, ws)
				if err != nil {
					return Result{}, err
				}
				return d.showPageTab(ctx, uctx, a, tabProjs, map[string]string{ViewProjectsWorkspaceParam: w.GetId()})
			}
			// The index: an open tab on a project's page goes back to it. The window did so on
			// this verb's ShowView until the tab became its whole effect (shell-22-retire-verbs.md).
			return d.showPageTab(ctx, uctx, a, tabProjs, map[string]string{})
		},
	}
}
