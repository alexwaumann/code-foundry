package command

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
)

// ViewUsage is the ShowView name of the Usage page: token usage and its cost over every
// thread the daemon tracks (docs/notes/session-usage.md). A window shows it (a window
// that shows it already keeps it); only the window's own key and sidebar button toggle
// it, like the settings page.
const ViewUsage = "usage"

// ViewBack is the ShowView name that goes back to what had the focus before (a tab, a pane,
// a space) in the window's focus history. It is an action on per-window GUI state, not a
// page: a window at the start of its history ignores it.
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

// hasWorktreeThreadContext is view.open.diff's availability: a thread is active and
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
	// Files backs view.open.file's check (FilesystemService.ReadFile).
	Files FileReader
	// FileEdits backs view.open.file --edit's check (Filesystem.CheckEdit).
	FileEdits FileEditChecker
	// Diffs backs view.open.diff's check (ProjectService.CompareWorktree).
	Diffs WorktreeComparer
	// Projects finds a thread's project's GitHub repository for view.open.pr
	// (ProjectService.List).
	Projects ProjectLister
	// PullRequests backs view.open.pr's check (GhService.GetPullRequest).
	PullRequests PullRequestChecksBackend
	// Inline backs view.inline (ThreadService.ShowHtml; commands_view_inline.go).
	Inline HTMLShower
	// Settings lists the settings pages view.settings --page takes (SettingsService.GetSchema).
	// Nil: only the GUI's own pages (SettingsGUIPages).
	Settings SettingsSchemaReader
	// Workspaces resolves view.projects --workspace (an id or a name) to its id. Nil: the
	// value goes to the GUI as given.
	Workspaces WorkspaceLister
	// Layout is the shell window's layout: the item verbs, view.pullrequests and
	// view.projects open their tabs in it, and view.thread-diff moves between a thread and
	// its diff (commands_view_open.go). Nil: those verbs refuse (there is nowhere to open a tab).
	Layout layoutstore.Store
}

// noFileEdits is FileEdits when nothing backs it.
type noFileEdits struct{}

func (noFileEdits) CheckEdit(context.Context, string, string) (string, error) {
	return "", connect.NewError(connect.CodeUnimplemented, errors.New("no file checks here"))
}

// pageFocusArg is the page verbs' --focus.
var pageFocusArg = ArgSpec{Name: "focus", Type: Bool,
	Description: "Show it even when no window shows the thread this runs in: every window moves there; only when the user asked to be taken there"}

// showPage runs a page verb whose page is a sheet over every window (usage, settings, help):
// ShowView name in every window. Every window moves to the page, so a call from a thread's
// CLI (CallerThreadID set) is refused while no window shows that thread, unless --focus says
// the user asked: a model must not take the user's windows from what they are doing. The
// app's own palette and keys, and the CLI outside a thread, are unchanged. With no window
// open there is nothing to take over: it says so.
func (d ViewDeps) showPage(uctx Context, a Args, name string) (Result, error) {
	if err := d.refusePage(uctx, a); err != nil {
		return Result{}, err
	}
	return EmitTo(d.Emitter, showViewIntent(name, nil)).CLIResult(uctx), nil
}

// refusePage is a page verb's refusal from a thread's CLI while no window shows that thread.
func (d ViewDeps) refusePage(uctx Context, a Args) error {
	fromThread := uctx.ActiveView == "" && uctx.CallerThreadID != ""
	if fromThread && !a.Bool("focus") && d.Viewed != nil && d.Emitter.Windows() > 0 && !d.Viewed(uctx.CallerThreadID) {
		return connect.NewError(connect.CodeFailedPrecondition, errNotViewed)
	}
	return nil
}

// RegisterView registers the View category's verbs:
//
//   - the pages: view.usage, view.settings and view.help, which move every window
//     (UiIntent.ShowView, showPage), and view.pullrequests and view.projects, a tab of the
//     layout (showPageTab);
//   - actions on each window's state (ShowView): view.back, view.forward, thread.previous
//     and thread.next;
//   - the item verbs (commands_view_items.go): view.open.file, view.open.diff and
//     view.open.pr, each a tab of the layout (commands_view_open.go), with its old
//     view.panel.<item> name as an unlisted alias (view.open.mcp lives with its domain);
//   - view.inline (commands_view_inline.go), which shows an HTML page in a thread's
//     conversation (category Thread), and view.open.page (commands_view_panel_page.go),
//     which shows one in a tab only, and view.open.gallery
//     (commands_view_panel_gallery.go), which shows a set of images there;
//   - view.thread-diff (commands_view_open.go), the key between a thread and its diff;
//   - composer.history (commands_view_composer.go), the Previous prompts picker, and
//     composer.stage (commands_composer_stage.go), text in a thread's composer;
//   - view.thread-info (commands_view_thread_info.go), the thread info card's toggle.
//   - file.find (commands_view_file_find.go), the file finder over the thread on screen,
//     and file.save (commands_view_file_save.go), the window's own save of a File tab.
//
// Links open through view.open.url (RegisterGitOps).
func RegisterView(r *Registry, d ViewDeps) error {
	if d.Files == nil {
		d.Files = codefoundryv1connect.UnimplementedFilesystemServiceHandler{}
	}
	if d.FileEdits == nil {
		d.FileEdits = noFileEdits{}
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
			return EmitTo(d.Emitter, showViewIntent(name, nil)).CLIResult(uctx), nil
		}
	}
	pageArgs := []ArgSpec{pageFocusArg}
	pageTab := func(kind string) func(context.Context, Context, Args) (Result, error) {
		return func(ctx context.Context, uctx Context, a Args) (Result, error) {
			return d.showPageTab(ctx, uctx, a, kind, nil)
		}
	}
	cmds := []Command{
		{
			Name:        "view.usage",
			Page:        PageState,
			Title:       "Usage",
			Description: "Show the Usage page in every app window: token usage and its cost per day and per model over every thread.",
			Category:    "View",
			// No default chord; bindable in settings. The CLI's report is usage.show.
			Args: pageArgs,
			Run:  page(ViewUsage),
		},
		{
			Name:        "view.pullrequests",
			Page:        PageState,
			Title:       "Show Pull Requests",
			Description: "Show the Pull Requests page, its tab in the current space: pull requests that need your review, your open ones with what each needs, and recent merges, in every repository.",
			Category:    "View",
			// No default chord since the shell (docs/notes/shell-model.md, "Keys": the palette and a
			// pane's "+" open it); bindable in settings.
			Args: []ArgSpec{pageFocusArg, openPaneArg},
			Run:  pageTab(tabPRs),
		},
		d.projectsCommand(),
		d.settingsCommand(),
		{
			Name:        "view.help",
			Page:        PageState,
			Title:       "Keyboard Shortcuts and Help",
			Description: "Show keybindings and how the app works in every app window.",
			Category:    "View",
			Keybindings: []string{"cmd+/"},
			Args:        pageArgs,
			Run:         page(ViewHelp),
		},
		{
			Name:        "view.back",
			Page:        PageState,
			Title:       "Back",
			Description: "Go back to what was focused before: a tab, a pane, a space.",
			Category:    "View",
			Keybindings: []string{"cmd+["},
			Run:         show(ViewBack),
		},
		{
			Name:        "view.forward",
			Page:        PageState,
			Title:       "Forward",
			Description: "Go forward again to what was focused before going back.",
			Category:    "View",
			Keybindings: []string{"cmd+]"},
			Run:         show(ViewForward),
		},
		{
			Name:        "thread.previous",
			Page:        PageState,
			Title:       "Previous Thread",
			Description: "Select the thread above the current one in the sidebar.",
			Category:    "View",
			// cmd+shift+[ is tab.previous since the shell (docs/notes/shell-model.md, "Keys").
			Run: show(ViewThreadPrevious),
		},
		{
			Name:        "thread.next",
			Page:        PageState,
			Title:       "Next Thread",
			Description: "Select the thread below the current one in the sidebar.",
			Category:    "View",
			// cmd+shift+] is tab.next since the shell.
			Run: show(ViewThreadNext),
		},
	}
	cmds = append(append(cmds, d.itemCommands()...), withAliases(d.panelPageCommand(), d.panelGalleryCommand())...)
	cmds = append(cmds, d.threadDiffCommand(), d.inlineCommand(), d.composerHistoryCommand(), d.composerStageCommand(), d.threadInfoCommand(), d.paneFullscreenCommand(), d.fileFindCommand(), d.fileSaveCommand(), d.searchOpenCommand())
	return r.RegisterAll(append(append(append(cmds, d.threadFindCommands()...), d.terminalFindCommands()...), d.fileSearchCommands()...)...)
}
