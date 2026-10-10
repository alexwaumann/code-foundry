package command

import (
	"context"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// ViewPullRequests is the ShowView name of the Pull Requests page.
const ViewPullRequests = "pullrequests"

// ViewProjects is the ShowView name of the Projects page: every project (registered
// repository) with its worktrees, and every workspace with its members.
const ViewProjects = "projects"

// ViewPanelToggle is the ShowView name that toggles the side panel of whatever the
// window has selected. It is an action, not a page: the GUI toggles its per-selection
// panel state (gui/frontend/src/stores/panel.ts) and stays on the current selection.
const ViewPanelToggle = "panel.toggle"

// ViewPanelExpand is the ShowView name that toggles the selection's side panel between
// its split width and the full width of the content area. Like ViewPanelToggle it is an
// action on per-selection GUI state, not a page; expanding a hidden panel shows it.
const ViewPanelExpand = "panel.expand"

// ViewPanelWorkspace is the ShowView name that opens (or reveals) the workspace surface
// in the side panel of the selected workspace thread: the workspace's members with their
// git and pull request state. Like ViewPanelToggle it is an action on per-selection GUI
// state, not a page; a window whose selection is not a workspace thread ignores it.
const ViewPanelWorkspace = "panel.workspace"

// ViewPanelLinkedPRs is the ShowView name that opens (or reveals) the Linked PRs surface
// in the side panel of the selected thread: the pull requests Claude linked to it (its
// pr-link transcript records). An action on per-selection GUI state like
// ViewPanelWorkspace; a window whose selection is not a thread ignores it, and one whose
// thread has no linked pull requests says so instead of opening an empty surface.
const ViewPanelLinkedPRs = "panel.linked-prs"

// hasWorkspaceThreadContext is view.panel.workspace's availability: a thread is active
// and it belongs to a workspace (the GUI passes the thread's workspace as
// ActiveWorkspaceID; the CLI with --context-session and --context-workspace).
func hasWorkspaceThreadContext(c Context) bool {
	return hasSession(c) && c.ActiveWorkspaceID != ""
}

// RegisterView registers view.pullrequests, which shows the Pull Requests page,
// view.projects, which shows the Projects page, view.panel.toggle, which shows or hides
// the side panel, view.panel.expand, which switches it between split and full width, and
// view.panel.workspace, which opens the workspace surface in it, and
// view.panel.linked-prs, which opens the thread's linked pull requests in it (all
// emitted as UiIntent.ShowView). Links open through view.open.url (RegisterGitOps).
func RegisterView(r *Registry, e Emitter) error {
	show := func(name string) Result {
		n := e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: name}}})
		// No Message: the GUI toasts non-empty messages, and the view change is
		// feedback enough. The CLI's --json still reports delivery.
		return Result{JSON: EmitResult{Delivered: n}}
	}
	return r.RegisterAll(
		Command{
			Name:        "view.pullrequests",
			Title:       "Show Pull Requests",
			Description: "Show the Pull Requests page: your open pull requests, reviews requested from you, and recent merges across registered repositories.",
			Category:    "View",
			Keybindings: []string{"cmd+shift+d"},
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewPullRequests), nil
			},
		},
		Command{
			Name:        "view.projects",
			Title:       "Show Projects",
			Description: "Show the Projects page: each project's worktrees and each workspace's members, with their git state and actions.",
			Category:    "View",
			Keybindings: []string{"cmd+shift+j"},
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewProjects), nil
			},
		},
		Command{
			Name:        "view.panel.toggle",
			Title:       "Toggle Side Panel",
			Description: "Show or hide the side panel next to the selected session, terminal, worktree, or page.",
			Category:    "View",
			Keybindings: []string{"cmd+shift+e"},
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewPanelToggle), nil
			},
		},
		Command{
			Name:        "view.panel.expand",
			Title:       "Expand Side Panel",
			Description: "Toggle the side panel between its split width and the full width of the content area for the selected session, terminal, worktree, or page.",
			Category:    "View",
			// No default chord (the user's choice); bindable in settings.
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewPanelExpand), nil
			},
		},
		Command{
			Name:  "view.panel.workspace",
			Title: "Show Workspace in Side Panel",
			Description: "Open the workspace surface in the selected workspace thread's side panel: " +
				"its members with branch, changes, ahead/behind and pull request, add and remove members, Run in.",
			Category: "View",
			// No default chord, like view.panel.expand (W opens it while the panel has focus).
			When: hasWorkspaceThreadContext,
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewPanelWorkspace), nil
			},
		},
		Command{
			Name:  "view.panel.linked-prs",
			Title: "Show Linked PRs in Side Panel",
			Description: "Open the Linked PRs surface in the selected thread's side panel: " +
				"the pull requests the thread created or touched, newest first, with state, checks and branch.",
			Category: "View",
			// No default chord, like view.panel.workspace (L opens it while the panel has
			// focus). Available for any thread, even one without links, so the palette
			// finds it and the GUI can say there are none yet.
			When: hasSession,
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewPanelLinkedPRs), nil
			},
		},
	)
}
