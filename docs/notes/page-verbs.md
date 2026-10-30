# Page verbs

Four verbs a page shown in a thread can call through `cf.run` (the bridge runs them as the
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
- **`dictation` is not a page.** It is a section of General. `--page general` reaches it.

## Verified

- Go: table tests for each verb's branches (`commands_composer_stage_test.go`,
  `commands_view_settings_test.go`, `TestProjectAddOpensTheDialog`,
  `commands_theme_reset_test.go` over a real settings store and themes directory).
  palette_test, keybindings_test and the registry count are updated.
- Vitest: the intent mapping, staging (empty draft, appended, another thread),
  `settings.<page>` and `project.add` in `showView`.
- Playwright (mock daemon): `e2e/page-verbs.spec.ts` emits each intent and checks the
  composer, the Settings nav and the dialog.
- Real daemon with a scratch home and the CLI: the composer.stage refusals, project.add's
  hint with no window, `--page memory` ("no app window is open") and an unknown page,
  and theme.reset with and without `--slot`.

## Gotchas

- `InvalidArg`'s error text has no `argument "x":` prefix when it comes from a Run
  (unlike a parse error), so tests match the message only.
- The settings file keeps commented `# theme_dark = …` lines, so a test for "unset" has to
  match only uncommented `^key =` lines.
