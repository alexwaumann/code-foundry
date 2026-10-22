# Inline HTML pages: fixes from the test fan-out (2026-10-22)

Testers ran `view.inline` against main at #325 (inline-html.md). Nine findings, fixed here
in priority order. Daemon, GUI, mock, skills and capabilities text.

## 1. Frames follow the app's scheme, not macOS

A page with an `@media (prefers-color-scheme: dark)` block went unreadable when the app's
scheme differed from macOS's: the frame's `prefers-color-scheme` was the system's.

- `HtmlFrame` sets the iframe element's own `color-scheme` (inline style) to the active
  theme's scheme. WebKit hands that to the embedded document as its preferred colour
  scheme, sandboxed frames included, and **live**: changing it fires the page's
  `matchMedia` change event, so such a page repaints with no reload.
- Measured in Playwright's WebKit (an outer page, four frames, the OS emulated dark and
  light): an explicit `color-scheme: light` on the iframe gave `prefers-color-scheme:
  light` inside whatever the OS said; **an inherited value does not count**. `<html>`
  already had `color-scheme` from `syncDocumentScheme`, and a frame without its own
  value still followed the OS. So the wrapper's value does nothing; the element's own
  does. Chromium (not shipped) ignored the property in both cases.
- No fallback through `/cf/theme.css` was needed (a stylesheet or `<meta
  name="color-scheme">` cannot change what a media query in the document sees anyway).
- The skills and capabilities say: paint with the `--cf-*` variables, never fixed
  colours or `prefers-color-scheme`.

## 2. No fake "Interrupted" turn after a page

`view.inline` into a connected thread at its prompt (from a terminal with `--thread`, or
from a child) appended the html item after the last turn end. `openTurn` took it as the
start of an open turn, so the process ending later (daemon restart, auto-stop, close)
wrote `turn end: process_ended (interrupted)` after the page, and the GUI folded the card
under "Interrupted after N min".

- `openTurn` (turnclose.go) starts a turn only at an item that can start one
  (`startsTurn`): not an error (as before), not an html item, not a command output. The
  last two are what the daemon appends between turns on its own: an html item a verb put
  in an idle thread, and an effort restart's "Set effort to …" / "Restarted Claude",
  which had the same bug. Inside a turn they follow its first message, so nothing
  changes there; a local command's output comes after the message that ran it.
- Notes were already a boundary; errors already never started a turn. The other
  verb-appended items (the wake-limit, budget and agent notes) are notes.
- Tests: `TestOpenTurn` rows (a page or "Set effort" between turns, before any turn, then a
  message, inside a turn, before Claude starts a turn itself) and
  `TestPageOutsideATurnEndsNoTurn` (idle or after a turn; exit, close, archive, daemon
  restart: no daemon turn end, the page last). The test fails without the fix.

## 3. Theme switch: ack or reload

#325 reloaded every frame on a theme change, wiping a page's state. Now:

- On a theme change the frame is posted `cf:theme` (as before). A page that applies it
  replies `{ type: "cf:theme:ack" }` (from its own window: `event.source` is checked) and
  keeps its state.
- Once the daemon has the new theme (`onThemePublished`) and the page has not acked it, the
  frame is posted the theme again and reloads `THEME_ACK_MS` (300 ms) later unless an ack
  arrived meanwhile. A stylesheet-only page still repaints (its fresh load fetches the
  new `/cf/theme.css`).
- Leaving a thread and coming back remounts its frames (the virtualizer drops them), which
  reloads the page: acceptable, and the same for the File tab.
- The mock's inline page acks; e2e: a listening page keeps "Hello x1" across a switch, a
  stylesheet-only page reloads (`data-load` 1) and repaints.

## 4. Pages between turns arrive open

An html item outside any turn was grouped into the next "turn" by the GUI (`buildTurns`):
the next user message became a steer inside it, and that turn's end folded the card with
a "folded" label, as did the fake turn end of finding 2.

- `isAside` (threadTimeline.ts): items the daemon adds between turns with no user message
  before them (command output, as before, and now html) are no turn: the next message
  starts its own, they have no header and never fold. A system-note-like turn of pages
  takes the live header after it, as a note does.
- Inside a turn an html item follows the turn's fold as before, and a page shown while the
  user watched stays open through the turn's own fold (inline-html.md). The "Showed" row
  keeps its chevron.
- The mock has a new `html-idle` state (three pages after a finished turn).

## 5. Routing and guidance

- **`view.inline` warns.** After showing the page it reads it (FilesystemService.ReadFile,
  256 KiB) and adds warnings (stderr `warning:` lines, and `warnings` in `--json`):
  - no `/cf/theme.css` in the file: "page does not link /cf/theme.css, so it will not
    follow the user's theme; add `<link rel="stylesheet" href="/cf/theme.css">` and use
    --cf-* variables (--cf-surface, --cf-text, --cf-text-muted, --cf-accent, --cf-border,
    …), not fixed colours or prefers-color-scheme";
  - no `cf:resize` in the file: "page does not post cf:resize, so its card keeps the
    default height; on load, post {type: "cf:resize", height: document.body.scrollHeight}
    to parent". Whether a page is short is not detectable, so this one fires for every
    page without the message.
  A plain substring test: a page naming them in a comment passes, fine for a hint.
- **Entry skill** (70 of 70 lines): the routing row reads "A page, chart or HTML you make;
  a form, checklist or countdown "as a page" or "I can fill in"" → an `.html` file in
  `$CODE_FOUNDRY_PAGES`, then `view.inline` (not markdown). "Showing things" gains a
  paragraph: pages in `$CODE_FOUNDRY_PAGES`, never the repository or home folder; the
  stylesheet; the eight variables by full name (`--cf-canvas`, `--cf-surface`,
  `--cf-surface-raised`, `--cf-text`, `--cf-text-muted`, `--cf-accent`, `--cf-border`, the
  status triples `--cf-success`/`--cf-warning`/`--cf-error` with their `-surface` and
  `-foreground`) and the type roles; never fixed colours or `prefers-color-scheme`;
  `cf:resize`; `view.inline` warns. Paid for by folding "Discovering what exists" (six
  lines) into the table's capabilities row, which keeps every group name and "it reads
  the running app".
- **Help skill** (105 of 105): the page paragraph says forms and checklists asked "as a
  page" are `.html` files in `$CODE_FOUNDRY_PAGES`, not markdown; points at the entry
  skill for the variable names; adds "never fixed colours or `prefers-color-scheme`" and
  "reply `{type: "cf:theme:ack"}` to its parent to keep your state (else the frame
  reloads)". Paid for by: the `commands.md` bullet's list of categories, the "Settings page
  (⌘,) shows the same settings" sentence, and step 4 of "Explain first, then offer" (the
  `--yes` rule, which the entry skill's "Good to know" states).
- **Capabilities**: the panel group's view.inline line names `$CODE_FOUNDRY_PAGES` and the
  warnings; the rendering group's html line names the ack, the 300 ms reload and the
  frame's scheme.
- **ThreadPrompt** (1426 of 1430 bytes): "show .html pages: view.inline <file>" became "a page,
  chart or form to fill in is an .html file shown with view.inline <file>, not markdown".
  Paid for by "cost and usage:" → "cost:", "to show a file, diff, PR, usage or worktree:" →
  "to show something:" (the verbs follow it), and dropping ", which the app replaces" after
  /model or /cost. The memory clause is untouched. Without it Haiku answered the form
  prompt in markdown and loaded no skill (see the run below). Skill descriptions unchanged.
- **A user-level `dataviz` skill** (in `~/.claude/skills`) can win over the app's skills
  for chart prompts: the model then follows its method and may skip the stylesheet.
  Nothing to fix in the repo; the warnings tell the model afterwards.

## 6. Where pages go

- `paths.Pages()` = `<CODE_FOUNDRY_HOME>/pages`; each thread gets `pages/<id>`, made (0700)
  at every spawn and given to its claude as `CODE_FOUNDRY_PAGES` and as an `--add-dir`
  (after the attachments dir), so an accept-edits thread writes there without asking.
  Removed with the thread (Remove) and, for threads that are gone, at New, beside the
  TMPDIR, which is `<home>/tmp/<id>` (childcontext.go: one set of helpers for both roots).
- Why not the TMPDIR: the preview floor guards the whole config home except its
  checkouts, and opening `tmp` would expose every thread's scratch files to a page.
  `pages` is added to the floor's open trees; `tmp` stays guarded (floor tests).
- The daemon scrubs an inherited `CODE_FOUNDRY_PAGES` from its own environment.
- `view.inline` accepts only files under home, so a config home outside home (a test
  daemon with `CODE_FOUNDRY_HOME=/tmp/…`) gives pages that are refused. Isolated test
  homes for this go under `$HOME`.

## 7. Error text

- A missing file says "no file at <path>" (`pageNotFound`, still `ErrNotFound`/NotFound),
  not "thread not found: no file at …".
- `view.inline` is `When: hasThreadOrCLI`: from the CLI outside a thread (no
  `$CODE_FOUNDRY_THREAD`, no `--thread`) it reaches its own "needs a thread to show it in
  (--thread, or run it inside a thread)" instead of "not available in this context". In
  the app with no thread it is still unavailable.

## 8. Keyboard inside frames

The app cannot see keys pressed inside a frame (another document, opaque origin), so Esc
does not close the lightbox and ⌘[ / ⌘] do nothing while a frame has focus. The cheap
parts:

- Opening the lightbox moves focus to its Close button, not the frame, so Esc works at once.
- The strip has a visible **Close** button (an X and the word; it replaced the icon-only
  Collapse, whose minimise icon did not read as close). Closing hands focus back to the
  card's Expand button (not "what had focus": WebKit does not focus a button on click).
- Close is reachable from the strip's other actions with Option+Tab, as every button in
  WebKit is (plain Tab moves between buttons only with macOS's Keyboard navigation on).
- After a click inside the page, Esc and ⌘[ are the page's: click Close or the dimmed edge.

## 9. Lightbox size

The lightbox covers the whole window (portal to `document.body`, `fixed`, z-40, under
dialogs and tooltips): the box runs from the title band's bottom (56 px, clear of the
traffic lights) to 12 px from the other edges, over the sidebar, the thread and the side
panel. e2e checks it spans the side panel.

## End to end (2026-10-22, built app, isolated home)

`make gui-build`; daemon and GUI with `CODE_FOUNDRY_HOME=~/cf-inl2-home` (under home, so
pages in it pass `view.inline`) and the CLAUDE* variables unset; a non-git scratch folder
`~/cf-scratch-inl2` registered. macOS in Dark mode throughout.

- **Scheme.** App on GitHub Light, a page with only a hard-coded `prefers-color-scheme`
  block, shown with `view.inline --thread` from the terminal: "This page sees LIGHT",
  white. App to dark: "sees DARK" at once, no reload. WKWebView honours the iframe's
  `color-scheme`. `view.inline` printed the theme.css warning for it.
- **Theme switch.** A listening page (acks) clicked twice and a stylesheet-only page
  clicked once, then light → dark: the listening page kept "2 clicks" and counted its
  second theme message; the stylesheet-only page reloaded ("0 clicks") in the dark theme.
- **No fake turn.** Those three pages went into a connected thread at its prompt; the
  daemon was then stopped (the GUI started a new one): `thread items` ends with the three
  pages, no turn end after them. In the GUI they are open, outside the folded turn.
- **Errors.** A missing file: "no file at …". No thread and no `--thread`: "needs a
  thread to show it in (--thread, or run it inside a thread)".
- **Haiku 5.5** (`claude-haiku-5-5[1m]`, medium, auto), "give me a form I can fill in for a
  release checklist", a fresh thread each time:
  - before the ThreadPrompt change: no skill, a markdown checklist;
  - after it: the entry skill loaded, `echo $CODE_FOUNDRY_PAGES`, wrote
    `release-checklist.html` there, ran `view.inline` unprompted (no warnings), and said
    "a fillable page, not markdown". The page links `/cf/theme.css`, posts `cf:resize`,
    and paints only with `--cf-*` variables (canvas, surface, surface-raised, text,
    text-muted, accent, border, success/error foreground): no hex colour, no
    `prefers-color-scheme`. It rendered themed in dark and light, inline and in the
    lightbox, which covers the whole window with Close at the strip's end.
- Found on the way: the lightbox, now portalled to `document.body`, lost the thread's
  scoped `.mono` (the path showed in the sans font); its root carries `cf-thread` again.

## Left alone (as asked)

`thread get --json` items, the strip's original path after an in-frame navigation, a
subagent's pages rendering in the parent, the overscan of 8 frames.

## Gotchas

- The worktree agent sandbox refuses compound shell commands with heredocs; file edits went
  through the editor.
- Existing threads keep their argv until they next spawn: their `CODE_FOUNDRY_PAGES` and
  `--add-dir` arrive on the next start after the daemon restart.

## Daemon restart

Needed: the turn rule, the pages folder and env, the preview floor, the verb's warnings and
availability, capabilities text and the skills (written at daemon start). GUI and daemon
ship together.
