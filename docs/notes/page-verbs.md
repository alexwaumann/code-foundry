# Page verbs

Five verbs a page shown in a thread can call through `cf.run` (the bridge runs them as the
CLI in that thread), as pre-work for a first-run welcome page. Each one also works from a
plain CLI.

## What shipped

- **`composer.stage <text> [--thread]`** puts text in a thread's composer without sending
  it. It travels as a new intent, `UiIntent.StageComposer {thread_id, text}`. A window
  whose selection is that thread replaces an empty draft, or adds the text on a new line
  after the draft (trailing whitespace trimmed), and bumps `promptFocusSeq`
  (`stores/composerText.ts stageInThreadComposer`). Any other window ignores the intent
  and keeps its selection. `--thread` defaults to the calling thread (ContextThread, so
  the bridge fills it in). The thread is checked to exist (NotFound otherwise). The
  daemon sends the intent only while a window is open and `Viewed(thread)` says one shows
  the thread. Otherwise it says "no app window shows thread … : nothing was staged" with
  exit 0, like the other intent verbs with no window. It has NoPalette and NoKeybinding:
  it is for pages and agents.
- **`project.add` without a path** opens the Add Project dialog in the windows through
  `ShowView "project.add"` (the GUI's `showView` calls `openAddProject()`). The hint is
  printed only when no window can show the dialog: none is open, or the call comes from a
  thread that no window shows. The palette is unchanged: the GUI presents project.add
  itself and never invokes it. `RegisterProjectAdd` takes an `AddProjectDialog{Emitter,
  Viewed}`, and its zero value keeps the old answer.
- **`view.settings --page <id>`** sends `ShowView "settings.<id>"`, which follows
  `themes.dark` and `themes.edit.<id>`. The GUI calls `openSettingsPage`, so an open sheet
  moves to that page. The valid ids are the schema's pages (`SettingsService.GetSchema`,
  through the new `ViewDeps.Settings`) followed by the GUI's own pages
  (`command.SettingsGUIPages`: plugins, skills, memory). An unknown id is InvalidArgument
  and lists every valid id. `TestSettingsGUIPagesMatchTheGUI` reads `guiPages.ts` and
  fails when the two lists drift. Without `--page`, nothing changes. There is no
  `view.themes` verb, so nothing was added there.
- **`theme.reset [--slot dark|light]`** writes an empty value to the slot's setting (as
  `settings.reset` does), so the slot shows the built-in default theme and keeps following
  it if the default changes. No theme file is touched. Without `--slot` it resets the
  slot in use (`themeShowing`: the scheme setting, or for `system` the scheme the window
  published). With `system` and no window it is InvalidArgument and asks for `--slot`.
  It is in the palette (a user action; its optional slot is not prompted, so it resets
  the slot in use).
- **`view.panel.page <path> [--title] [--thread] [--focus]`** opens an HTML page in the
  side panel of every window showing the thread, with no card in the conversation. It is
  view.inline `--panel`'s panel half alone: the same `showScoped(… ViewPanelFile,
  fileCheck)` path, so the same File tab frame (reloaded on every edit), the same
  home-directory rule (FilesystemService.ReadFile), the same preview grant, plus the
  .html/.htm check view.inline makes. Its ShowView `panel.file` carries two more params,
  `page=1` and `title`. `--thread` defaults to the calling thread, so a page's
  `cf.run("view.panel.page", {path})` opens in its own thread's panel. It prints the page's
  warnings like view.inline, except the card-height one (the panel frame fills its tab).
  NoPalette (it takes a path, like view.panel.file) and NoKeybinding.

## Decisions

- **A new intent for staging, ShowView for the rest.** A thread-scoped ShowView is
  reserved for panel actions (`threadPanelIntent.ts`), and the text is not a view
  parameter. Opening the dialog and opening a Settings page are window actions, which
  ShowView names already cover (`composer.history`, `dictation.toggle`).
- **"Shows the thread" means the window's selection.** Drafts live in memory per window,
  so staging into a window that does not show the thread would leave text the user never
  sees in that window. The daemon's `Viewed` (any WatchThread stream) can be true while
  the window shows the thread somewhere other than its selection; that window then does
  nothing, which is harmless.
- **One newline, not a blank line.** The brief asked for "a new line". The page-error
  strip's `putInThreadComposer` still adds a blank line and still selects the thread;
  both behaviours are kept.
- **project.add from a thread that no window shows prints the hint rather than refusing.**
  The verb has no `--focus`, and a dialog popping up over what the user is doing because
  a model ran `project add` is the case the page-verb guard exists for.
- **A panel-only page gets its bridge from its tab, not from the log.** The File tab gave a
  page its thread's bridge only when the thread's log had an html item for that file
  (`usePageThread`). A panel-only page has none, so its bridge would have refused every
  call. Rather than a hidden html item in the log (a proto field, a renderer skip, and the
  @thread and transcript projections to teach), the tab carries `page=1` and its title
  (`surfaces/fileTarget.ts`). `usePageThread(abs, own)` trusts that flag only in a
  `thread:<id>` panel. Only the daemon's verb sets it, through the thread-scoped intent,
  so the trust is the same as an html item's: the thread asked to show the file as a page.
  Storage follows (its key prefix is the thread id).
- **The flag survives a second open.** `openFileInPanel` keeps `page` and `title` when the
  same file opens again without them (a path chip in a reply), since openTab replaces a
  tab's params and the page would lose its bridge.
- **`dictation` is not a page.** It is a section of General. `--page general` reaches it.

## Verified

- Go: table tests for each verb's branches (`commands_composer_stage_test.go`,
  `commands_view_settings_test.go`, `TestProjectAddOpensTheDialog`,
  `commands_theme_reset_test.go` over a real settings store and themes directory,
  `commands_view_panel_page_test.go`). palette_test, keybindings_test, readonly_test, the
  capabilities panel count (10 surfaces) and the registry count are updated. The guide
  stays under its soft cap of 25,600 with view.panel.page added, so the cap is unchanged.
- Vitest: the intent mapping, staging (empty draft, appended, another thread),
  `settings.<page>` and `project.add` in `showView`; a page tab's params and title, the flag
  kept on a second open, `panel.file` with `page=1`, and `usePageThread` (own page in a
  thread's panel, not in another panel).
- Playwright (mock daemon): `e2e/page-verbs.spec.ts` emits each intent and checks the
  composer, the Settings nav and the dialog. `e2e/page-verbs-panel.spec.ts` runs
  view.panel.page in s-1's context (as its bridge would): the panel opens on a tab titled
  Welcome, the page's bridge is s-1's (a ui.notify through it answers ok), and the
  conversation has no card. A file that is not a page is refused.
- Real daemon with a scratch home and the CLI: the composer.stage refusals, project.add's
  hint with no window, `--page memory` ("no app window is open") and an unknown page,
  and theme.reset with and without `--slot`.

## Gotchas

- `InvalidArg`'s error text has no `argument "x":` prefix when it comes from a Run
  (unlike a parse error), so tests match the message only.
- The settings file keeps commented `# theme_dark = …` lines, so a test for "unset" has to
  match only uncommented `^key =` lines.
