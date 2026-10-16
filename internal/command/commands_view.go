package command

import (
	"context"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// ViewDashboard is the ShowView name of the dashboard: the start page, and what the
// GUI selects when it loads.
const ViewDashboard = "dashboard"

// ViewPullRequests is the ShowView name of the Pull Requests page.
const ViewPullRequests = "pullrequests"

// ViewProjects is the ShowView name of the Projects page: every project (registered
// repository) with its worktrees, and every workspace with its members.
const ViewProjects = "projects"

// ViewUsage is the ShowView name of the Usage page: token usage and its cost over every
// thread the daemon tracks (docs/notes/session-usage.md). The GUI toggles it like the
// settings page.
const ViewUsage = "usage"

// ViewPanelToggle is the ShowView name that toggles the side panel of whatever the
// window has selected. It is an action, not a page: the GUI toggles its per-selection
// panel state (gui/frontend/src/stores/panel.ts) and stays on the current selection.
const ViewPanelToggle = "panel.toggle"

// ViewBottomToggle is the ShowView name that toggles the bottom panel (the terminals
// under the main content) of whatever the window has selected. Like ViewPanelToggle it
// is an action on per-selection GUI state, not a page. It only toggles: the GUI's own
// cmd+j (its presenter, not this intent) also starts a shell when the panel would open
// empty, so a CLI call reaching every window does not start one per window.
const ViewBottomToggle = "bottom.toggle"

// ViewPanelExpand is the ShowView name that toggles the selection's side panel between
// its split width and the full width of the content area. Like ViewPanelToggle it is an
// action on per-selection GUI state, not a page; expanding a hidden panel shows it.
const ViewPanelExpand = "panel.expand"

// ViewPanelNewTab is the ShowView name that shows the selection's side panel with its
// surface list ("Open a surface") so another tab can be opened next to the ones it has.
// Like ViewPanelToggle it is an action on per-selection GUI state, not a page: it shows a
// hidden panel, and no tab is added until a surface is picked.
const ViewPanelNewTab = "panel.new-tab"

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

// ViewPanelUsage is the ShowView name that opens (or reveals) the Usage surface in the
// side panel of the selected thread: its token usage and cost, per model and per token
// kind. An action on per-selection GUI state like ViewPanelLinkedPRs; a window whose
// selection is not a thread ignores it. A thread without usage shows "No usage yet".
const ViewPanelUsage = "panel.usage"

// ViewPanelWorktree is the ShowView name that opens (or reveals) the Worktree surface in
// the side panel of the selected thread: the overview of the worktree it runs in (sync
// state, GitHub activity, files, log). An action on per-selection GUI state like
// ViewPanelWorkspace; a window whose selection is not a thread in a registered worktree
// ignores it.
const ViewPanelWorktree = "panel.worktree"

// hasWorkspaceThreadContext is view.panel.workspace's availability: a thread is active
// and it belongs to a workspace (the GUI passes the thread's workspace as
// ActiveWorkspaceID; the CLI with --context-thread and --context-workspace).
func hasWorkspaceThreadContext(c Context) bool {
	return hasThread(c) && c.ActiveWorkspaceID != ""
}

// hasWorktreeThreadContext is view.panel.worktree's availability: a thread is active and
// it sits in a registered worktree (the GUI passes the placement as ActiveRepoID and
// ActiveWorktreePath; the CLI with --context-thread plus --context-repo and
// --context-worktree). A terminal alone does not count: the GUI never selects one (a
// Projects-page bottom shell brings its worktree, but the page has no thread).
func hasWorktreeThreadContext(c Context) bool {
	return hasThread(c) && hasWorktree(c)
}

// RegisterView registers view.dashboard, which shows the dashboard, view.usage, which
// shows the Usage page,
// view.pullrequests, which shows the Pull Requests page,
// view.projects, which shows the Projects page, view.panel.toggle, which shows or hides
// the side panel, view.bottom.toggle, which shows or hides the bottom panel, view.panel.expand, which switches it between split and full width,
// view.panel.new-tab, which shows its surface list to open another tab, and
// view.panel.workspace, which opens the workspace surface in it,
// view.panel.linked-prs, which opens the thread's linked pull requests in it,
// view.panel.usage, which opens the thread's usage in it, and
// view.panel.worktree, which opens the thread's own worktree in it (all emitted as
// UiIntent.ShowView). Links open through view.open.url (RegisterGitOps).
func RegisterView(r *Registry, e Emitter) error {
	show := func(name string) Result {
		n := e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: name}}})
		// No Message: the GUI toasts non-empty messages, and the view change is
		// feedback enough. The CLI's --json still reports delivery.
		return Result{JSON: EmitResult{Delivered: n}}
	}
	return r.RegisterAll(
		Command{
			Name:        "view.dashboard",
			Title:       "Show Dashboard",
			Description: "Show the dashboard.",
			Category:    "View",
			// No default chord; bindable in settings.
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewDashboard), nil
			},
		},
		Command{
			Name:        "view.usage",
			Title:       "Usage",
			Description: "Show the Usage page: token usage and its cost per day and per model over every thread.",
			Category:    "View",
			// No default chord; bindable in settings. The CLI's report is usage.show.
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewUsage), nil
			},
		},
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
			Description: "Show or hide the side panel next to the selected thread or page.",
			Category:    "View",
			Keybindings: []string{"cmd+shift+e"},
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewPanelToggle), nil
			},
		},
		Command{
			Name:        "view.bottom.toggle",
			Title:       "Toggle Bottom Panel",
			Description: "Show or hide the terminals under the selected thread or page. In the app, opening it with no terminal starts a shell.",
			Category:    "View",
			Keybindings: []string{"cmd+j"},
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewBottomToggle), nil
			},
		},
		Command{
			Name:        "view.panel.expand",
			Title:       "Expand Side Panel",
			Description: "Toggle the side panel between its split width and the full width of the content area for the selected thread or page.",
			Category:    "View",
			// No default chord (the user's choice); bindable in settings.
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewPanelExpand), nil
			},
		},
		Command{
			Name:        "view.panel.new-tab",
			Title:       "New Side Panel Tab",
			Description: "Show the surface list in the side panel of the selected thread or page, to open another tab there.",
			Category:    "View",
			// No default chord, like view.panel.expand: the + after the panel's tabs runs
			// it, and while the panel has focus each surface's letter opens that surface.
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewPanelNewTab), nil
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
			When: hasThread,
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewPanelLinkedPRs), nil
			},
		},
		Command{
			Name:  "view.panel.usage",
			Title: "Show Usage in Side Panel",
			Description: "Open the Usage surface in the selected thread's side panel: " +
				"its cost at Claude API rates, tokens and requests, per model and per token kind.",
			Category: "View",
			// No default chord, like view.panel.linked-prs (U opens it while the panel has
			// focus). Available for any thread, even one without usage yet.
			When: hasThread,
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewPanelUsage), nil
			},
		},
		Command{
			Name:  "view.panel.worktree",
			Title: "Show Worktree in Side Panel",
			Description: "Open the Worktree surface in the selected thread's side panel: " +
				"the overview of the worktree it runs in, with sync state, GitHub activity, changed files and log.",
			Category: "View",
			// No default chord, like view.panel.workspace (T opens it while the panel has focus).
			When: hasWorktreeThreadContext,
			Run: func(context.Context, Context, Args) (Result, error) {
				return show(ViewPanelWorktree), nil
			},
		},
	)
}
