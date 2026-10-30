package command

import (
	"context"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// ViewPullRequests is the ShowView name of the Pull Requests page.
const ViewPullRequests = "pullrequests"

// ViewProjects is the ShowView name of the Projects page: every project (registered
// repository) with its worktrees, and every workspace with its members.
const ViewProjects = "projects"

// ViewUsage is the ShowView name of the Usage page: token usage and its cost over every
// thread the daemon tracks (docs/notes/session-usage.md). A window shows it (a window
// that shows it already keeps it); only the window's own key and sidebar button toggle
// it, like the settings page.
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

// ViewPanelSplit is the ShowView name that splits the selection's side panel into two tab
// groups, or joins a split one back into one. Like ViewPanelToggle it is an action on
// per-selection GUI state, not a page: splitting shows a hidden panel, and a panel
// without tabs has nothing to split.
const ViewPanelSplit = "panel.split"

// ViewBack is the ShowView name that selects the thread or page selected before the
// current one, in the window's selection history (docs/notes/selection-history.md). Like
// ViewPanelToggle it is an action on per-window GUI state, not a page: a window at the
// start of its history ignores it.
const ViewBack = "back"

// ViewForward is the ShowView name that selects the thread or page after the current one
// in the window's selection history, after ViewBack went back. An action like ViewBack; a
// window at the end of its history ignores it.
const ViewForward = "forward"

// ViewThreadPrevious is the ShowView name that selects the thread above the current one in
// the window's sidebar order, wrapping at the top (docs/notes/thread-neighbours.md). An
// action on per-window GUI state like ViewBack; from a page it selects the last row.
const ViewThreadPrevious = "thread.previous"

// ViewThreadNext is the ShowView name that selects the thread below the current one in the
// window's sidebar order, wrapping at the bottom; from a page it selects the first row.
const ViewThreadNext = "thread.next"

// hasWorktreeThreadContext is view.panel.diff's availability: a thread is active and
// it sits in a registered worktree (the GUI passes the placement as ActiveProjectID and
// ActiveWorktreePath; the CLI with --context-thread plus --context-project and
// --context-worktree). A terminal alone does not count: the GUI never selects one (a
// Projects-page bottom shell brings its worktree, but the page has no thread).
func hasWorktreeThreadContext(c Context) bool {
	return hasThread(c) && hasWorktree(c)
}

// ViewDeps are RegisterView's dependencies.
type ViewDeps struct {
	Emitter Emitter
	// Thread reads threads for the thread-scoped panel verbs (commands_view_thread.go).
	// Nil: they check nothing.
	Thread ThreadGetter
	// Viewed reports whether a window shows a thread now (PresenceDeps.Viewed): a page
	// verb from the CLI in a thread no window shows refuses without --focus. Nil: page
	// verbs never refuse.
	Viewed func(threadID string) bool
	// Files backs view.panel.file's check (FilesystemService.ReadFile).
	Files FileReader
	// Diffs backs view.panel.diff's check (ProjectService.GetWorktreeFileDiff).
	Diffs FileDiffer
	// Projects finds a thread's project's GitHub repository for view.panel.pr
	// (ProjectService.List).
	Projects ProjectLister
	// PullRequests backs view.panel.pr's check (GhService.GetPullRequest).
	PullRequests PullRequestChecksBackend
	// Inline backs view.inline (ThreadService.ShowHtml; commands_view_inline.go).
	Inline HTMLShower
	// Settings lists the settings pages view.settings --page takes (SettingsService.GetSchema).
	// Nil: only the GUI's own pages (SettingsGUIPages).
	Settings SettingsSchemaReader
}

// pageFocusArg is the page verbs' --focus.
var pageFocusArg = ArgSpec{Name: "focus", Type: Bool,
	Description: "Show it even when no window shows the thread this runs in: every window moves there; only when the user asked to be taken there"}

// showPage runs a page verb: ShowView name in every window. Every window moves to the
// page, so a call from a thread's CLI (CallerThreadID set) is refused while no window
// shows that thread, unless --focus says the user asked: a model must not take the
// user's windows from what they are doing. The app's own palette and keys, and the CLI
// outside a thread, are unchanged. With no window open there is nothing to take over:
// it says so.
func (d ViewDeps) showPage(uctx Context, a Args, name string) (Result, error) {
	fromThread := uctx.ActiveView == "" && uctx.CallerThreadID != ""
	if fromThread && !a.Bool("focus") && d.Viewed != nil && d.Emitter.Windows() > 0 && !d.Viewed(uctx.CallerThreadID) {
		return Result{}, connect.NewError(connect.CodeFailedPrecondition, errNotViewed)
	}
	return EmitTo(d.Emitter, showViewIntent(name, "", nil)).CLIResult(uctx), nil
}

// RegisterView registers the View category's verbs, all emitted as UiIntent.ShowView:
//
//   - the pages, which move every window: view.usage, view.pullrequests,
//     view.projects, view.settings and view.help (showPage);
//   - actions on each window's state: view.bottom.toggle, view.back, view.forward,
//     thread.previous and thread.next;
//   - the side panel verbs (commands_view_thread.go), which act on a thread's panel:
//     view.panel.toggle, expand, new-tab and split (view.panel.mcp lives with its
//     domain);
//   - the item verbs (commands_view_items.go): view.panel.file, view.panel.diff and
//     view.panel.pr;
//   - view.inline (commands_view_inline.go), which shows an HTML page in a thread's
//     conversation (category Thread), and view.panel.page (commands_view_panel_page.go),
//     which shows one in its side panel only;
//   - composer.history (commands_view_composer.go), the Previous prompts picker, and
//     composer.stage (commands_composer_stage.go), text in a thread's composer;
//   - view.thread-info (commands_view_thread_info.go), the thread info card's toggle.
//
// Links open through view.open.url (RegisterGitOps).
func RegisterView(r *Registry, d ViewDeps) error {
	if d.Files == nil {
		d.Files = codefoundryv1connect.UnimplementedFilesystemServiceHandler{}
	}
	if d.Diffs == nil {
		d.Diffs = codefoundryv1connect.UnimplementedProjectServiceHandler{}
	}
	if d.Projects == nil {
		d.Projects = codefoundryv1connect.UnimplementedProjectServiceHandler{}
	}
	if d.PullRequests == nil {
		d.PullRequests = codefoundryv1connect.UnimplementedGhServiceHandler{}
	}
	if d.Inline == nil {
		d.Inline = codefoundryv1connect.UnimplementedThreadServiceHandler{}
	}
	page := func(name string) func(context.Context, Context, Args) (Result, error) {
		return func(_ context.Context, uctx Context, a Args) (Result, error) { return d.showPage(uctx, a, name) }
	}
	show := func(name string) func(context.Context, Context, Args) (Result, error) {
		return func(_ context.Context, uctx Context, _ Args) (Result, error) {
			return EmitTo(d.Emitter, showViewIntent(name, "", nil)).CLIResult(uctx), nil
		}
	}
	panel := func(name string, check panelCheck) func(context.Context, Context, Args) (Result, error) {
		return func(ctx context.Context, uctx Context, a Args) (Result, error) {
			return showPanel(ctx, d.Thread, d.Emitter, uctx, a, name, check)
		}
	}
	pageArgs := []ArgSpec{pageFocusArg}
	cmds := []Command{
		{
			Name:        "view.usage",
			Title:       "Usage",
			Description: "Show the Usage page in every app window: token usage and its cost per day and per model over every thread.",
			Category:    "View",
			// No default chord; bindable in settings. The CLI's report is usage.show.
			Args: pageArgs,
			Run:  page(ViewUsage),
		},
		{
			Name:        "view.pullrequests",
			Title:       "Show Pull Requests",
			Description: "Show the Pull Requests page in every app window: pull requests that need your review, your open ones with what each needs, and recent merges, in every repository.",
			Category:    "View",
			Keybindings: []string{"cmd+shift+d"},
			Args:        pageArgs,
			Run:         page(ViewPullRequests),
		},
		{
			Name:        "view.projects",
			Title:       "Show Projects",
			Description: "Show the Projects page in every app window: each project's worktrees and each workspace's members, with their git state and actions.",
			Category:    "View",
			Keybindings: []string{"cmd+shift+j"},
			Args:        pageArgs,
			Run:         page(ViewProjects),
		},
		d.settingsCommand(),
		{
			Name:        "view.help",
			Title:       "Keyboard Shortcuts and Help",
			Description: "Show keybindings and how the app works in every app window.",
			Category:    "View",
			Keybindings: []string{"cmd+/"},
			Args:        pageArgs,
			Run:         page(ViewHelp),
		},
		{
			Name:        "view.panel.toggle",
			Title:       "Toggle Side Panel",
			Description: "Show or hide a side panel (from a thread: its own; in the app: the selected thread's or page's).",
			Category:    "View",
			Keybindings: []string{"cmd+shift+e"},
			Args:        panelThreadArgs(),
			Run:         panel(ViewPanelToggle, nil),
		},
		{
			Name:        "view.bottom.toggle",
			Title:       "Toggle Bottom Panel",
			Description: "Show or hide the terminals under the selected thread or page. In the app, opening it with no terminal starts a shell.",
			Category:    "View",
			Keybindings: []string{"cmd+j"},
			Run:         show(ViewBottomToggle),
		},
		{
			Name:        "view.panel.expand",
			Title:       "Expand Side Panel",
			Description: "Toggle a side panel between its split width and the full width of the content area (from a thread: its own; in the app: the selected thread's or page's).",
			Category:    "View",
			// No default chord (the user's choice); bindable in settings.
			Args: panelThreadArgs(),
			Run:  panel(ViewPanelExpand, nil),
		},
		{
			Name:        "view.panel.new-tab",
			Title:       "New Side Panel Tab",
			Description: "Show the surface list in a side panel, to open another tab there (from a thread: its own; in the app: the selected thread's or page's).",
			Category:    "View",
			// No default chord, like view.panel.expand: the + after the panel's tabs runs
			// it, and while the panel has focus each surface's letter opens that surface.
			Args: panelThreadArgs(),
			Run:  panel(ViewPanelNewTab, nil),
		},
		{
			Name:        "view.panel.split",
			Title:       "Split Side Panel",
			Description: "Split or unsplit a side panel into two tab groups (from a thread: its own; in the app: the selected thread's or page's).",
			Category:    "View",
			Keybindings: []string{`cmd+\`},
			Args:        panelThreadArgs(),
			Run:         panel(ViewPanelSplit, nil),
		},
		{
			Name:        "view.back",
			Title:       "Back",
			Description: "Return to the previously selected thread or page.",
			Category:    "View",
			Keybindings: []string{"cmd+["},
			Run:         show(ViewBack),
		},
		{
			Name:        "view.forward",
			Title:       "Forward",
			Description: "Go to the thread or page selected before going back.",
			Category:    "View",
			Keybindings: []string{"cmd+]"},
			Run:         show(ViewForward),
		},
		{
			Name:        "thread.previous",
			Title:       "Previous Thread",
			Description: "Select the thread above the current one in the sidebar.",
			Category:    "View",
			Keybindings: []string{"cmd+shift+["},
			Run:         show(ViewThreadPrevious),
		},
		{
			Name:        "thread.next",
			Title:       "Next Thread",
			Description: "Select the thread below the current one in the sidebar.",
			Category:    "View",
			Keybindings: []string{"cmd+shift+]"},
			Run:         show(ViewThreadNext),
		},
	}
	return r.RegisterAll(append(append(cmds, d.itemCommands()...), d.inlineCommand(), d.panelPageCommand(), d.composerHistoryCommand(), d.composerStageCommand(), d.threadInfoCommand())...)
}
