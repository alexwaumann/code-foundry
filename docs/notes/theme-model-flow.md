# Asking the model for a theme (2026-10-22)

PR 4 of 4 of the user themes series (1: hardening, #329; 2: themes as files, #328; 3: the
editor, #330; 4: this). Sketch C (the model flow) and sketch D's "Ask the model" button.
Decided with the user beforehand: the model applies the theme directly and the user relies
on Undo; the thread is the editor for most people; Ask the model lives on the Themes page
for discoverability. Daemon, proto, CLI, GUI, mock, skills.

## What shipped

- **The theme item.** `ThreadItem.theme` (`ThemeItem{theme: UserTheme, applied, previous}`,
  field 22; kind `theme` in `thread_items`, the JSON `data` column gains `theme: {file,
  applied, previous}`; no migration). `ThreadService.ShowTheme(thread_id, theme)` appends it
  where `ShowHtml` puts a page: on the runner's goroutine while the thread runs, else onto
  the stopped log. Both now go through one `Manager.verbItem` (html.go); `threadCmd.html`
  became `threadCmd.verb`. The file is validated again (`theme.ParseFile`, InvalidArgument).
  `startsTurn` and the GUI's `isAside` treat it like a page: between turns it is no turn.
  `thread items` prints `theme: <name> (<id>), <scheme>, applied (undo: <id>)`.
- **theme.save from a thread** (`themeCaller`: `$CODE_FOUNDRY_THREAD`, no active view) reads
  the slot first, saves, applies with `--apply`, then `showThemeCard`
  (commands_theme_card.go): the card, applied when `--apply` was given **or the slot already
  had this theme** (a refinement repaints too), `previous` = the slot before. A card that
  cannot be added is a warning line, not a failure. From the GUI and the user's terminal:
  no card, no toast.
- **The toast.** When applied, every window gets `Notify{title: "<name> applied to <scheme>",
  link: "theme-set:<scheme>:<previous>" "Undo", secondary_link: "theme-edit:<id>" "Edit",
  unless_showing: "themes"}` (no Undo link when there is no previous). New `UiIntent.Notify`
  fields: `secondary_link`, `secondary_link_label`, `unless_showing`. The GUI renders the
  second link as sonner's `cancel` button (it sits before the action), and
  `notifyLinks.showingPage` (a registry: `themes` → the Themes page is open) skips the toast
  in a window showing that page.
- **The card** (`components/thread/ThemeCard.tsx`, sketch C): the file's "Aa", name, `scheme
  · from <name>`, an "applied" badge, the nine base swatches, `N pinned · contrast ok | N
  contrast issues` (`contrastReport` on the file as saved, as the editor computes it),
  **Undo** (`theme.set-<scheme> <previous>`; disabled and "Undone" while the slot is on
  previous; hidden when not applied or no previous; a tooltip names the theme it goes back
  to) and **Edit** (`theme.edit`, disabled once the theme is deleted). A theme node never
  folds away, is no step and breaks a live strip's run.
- **`theme.ask [description] [--pair <id>] [--model] [--effort] [--permission auto]`**
  (commands_theme_ask.go, category Settings): a no-project thread (cwd `$HOME`), auto
  permission by default (what the composer defaults to: the save is a Bash call), the
  settings' default model and effort (`registryOverrides` ArgDefaults), then FocusThread.
  The first message is the user's words, then one parenthesised sentence: `(The user asked
  for this on the Themes page; the current dark theme is X (x) and light theme is Y (y). Make
  the theme they describe, save it with `code-foundry theme save --data - --apply`, and keep
  refining it in this thread (the code-foundry skill: Making a theme).)`. "On the Themes
  page" only when the command's active view is `themes`, which the GUI sends from the page
  (its UI context says "dashboard" or "thread" otherwise; it tracks the selection, not
  pages). `--pair <id>` (one of the user's themes) prepends "Make a light pair for my theme
  <id> (`code-foundry theme show <id>` prints it): same hues, a light scheme, saved as
  <id>-light with pair set both ways, applied as my light theme." (`ocean-dark` pairs as
  `ocean-light`; a light theme asks for a dark pair).
- **Ask the model** (`components/themes/AskTheModel.tsx`): a ghost button with the Sparkles
  icon (the app's "make something new" mark, as in Add project's New tab) at the end of the
  control bar; a popover with one field ("Describe a theme… warm dark, teal accent, quieter
  sidebar"), Enter or Send. On success the popover closes and the daemon's focus opens the
  thread (which leaves the page).
- **Also make a light pair** (SaveThemeDialog): shown only when the theme has no `pair`;
  after a successful save it runs `theme.ask --pair <id>` (dark pair for a light theme).
- **Skill and guide.** The entry skill has a routing row ("A colour theme for the app") and
  a "Making a theme" section: `theme list` / `theme show`, copy the closest with a new
  id/name/`from`, base colours first and pins only where a rule is wrong, the file in
  `$CODE_FOUNDRY_PAGES`, `theme save --file … --apply`, the card checks contrast (run no
  checker), `pair` only for your own pair, a sentence or two, offer the next step, refine by
  saving the same id. The description now ends "…page, HTML, chart or theme" (399 of 400:
  "and which skill" → ", which skill", "usage or cost" → "usage, cost"). THEMES.md (the help
  skill's reference/themes.md) gains a paragraph on cards and `theme ask`.
  `daemon.capabilities --group rendering` has a `themes` line. The guide grows by the verb
  name only (under its margin).
- **Cap raised:** the entry skill's line cap is 80, up from 70 (`skills_test.go`, with the
  reason): the theme flow has no other skill, and the help skill is at its cap too.
- Mock: `ThreadService.ShowTheme`-like `showTheme` with the refinement rule, theme.save from
  a thread context adds the card and toast, `theme.ask`, the scripted `theme` thread state,
  `POST /__mock/themes/card?thread=&theme=[&apply=true]`.

## Decisions

- **The card holds the file as saved**, not a theme id the GUI resolves now: "a later save
  of the same id appends a new card; it does not mutate the old one" needs the colours of
  that save. The full file (base, pins) rides in the item so the contrast summary is the
  saved file's too. Edit opens the theme as it is now.
- **Undo targets the theme before the thread's first apply.** A refinement's slot already
  holds the theme, so its own "previous" would be itself. The store's `inheritPrevious`
  gives such a card the latest earlier card's target (same id and scheme), so Undo on any of
  the thread's cards goes back to what the user had. Seen live: the pair turn re-saved the
  night theme and its new card kept "undo: github-dark".
- **The toast comes from the daemon** (as the memory toasts do), so it shows in a window
  whatever it watches; a thread's card only shows where the thread is open.
- **No `/cf/theme.json` in the skill.** The brief suggested reading it, but a thread has no
  URL for the loopback listener, and it holds resolved slots, not a theme file. `theme list`
  marks the current ids and `theme show` prints the file the model copies.

## What Haiku 5.5 did unprompted (built app, isolated home, `claude-haiku-5-5[1m]`, medium, auto)

Ask the model with the sketch's prompt, twice (the second after the fixes below):

1. Loaded the entry skill on its own, ran `theme list`, `theme show github-dark`, read the
   help skill's reference/themes.md and `theme show catppuccin-mocha`, wrote
   `tide-pool-night.json` in `$CODE_FOUNDRY_PAGES` and ran `theme save --data - --apply <
   file` with no further prompt. The card rendered (applied, Undo to GitHub Dark), the window
   repainted. Then it went looking for the contrast checker: `find / -name contrastPairs.ts`
   found the user's other checkouts, and it ran `pnpm run themes:check` from one of them (it
   passed). It set `"pair": "github-light"` (a curated theme) and `"from": "github-dark"`
   (the slot in use, not Mocha). 145 s. The thread's provisional name was the context
   sentence (the naming model failed in that environment).
2. After the fixes: skill, `theme list`/`show`, the reference, one Bash that wrote the file
   and saved it, done in 20 s. No checker hunt ("The contrast check is on the theme card in
   this conversation"), no `pair`, `from: github-dark` again, two sidebar pins
   (`--cf-sidebar`, `--cf-sidebar-row-selected`) for the quieter sidebar. The card said "2
   pinned · 1 contrast issue", which the model cannot see. The reply was a bulleted list,
   longer than the skill's "a sentence or two", and offered warmer, cooler or a light pair.
   "Now a light pair for daytime, please" in the same thread: `tide-pool-day` saved and
   applied as the light theme in 12 s, and the night theme re-saved with `pair` set both
   ways (two cards, two toasts).

Fixes from run 1: the first message puts the user's words first (the provisional name and
the bubble read as theirs); from a thread, the save's contrast line reads "checked on the
theme card this save added to your conversation, which the user sees (nothing to run)"
instead of pointing at the editor; the skill says "run no checker" and "`pair` only for your
own pair".

In the app: the toast "Tide Pool Night applied to dark" with Edit and Undo showed in the
Wails window (dark and light); the Themes page's own saves showed none. Undo on the card set
the dark slot back to GitHub Dark and both night cards turned to "Undone"; Edit opened the
editor on Tide Pool Night. The Wails window takes no synthetic clicks here (no accessibility
permission), so the popover, Undo and Edit were driven by Playwright WebKit running the same
frontend (vite dev, `?daemon=`) against the same isolated daemon; the window shots are
`screencapture -l <window id>` (found with CGWindowList by pid). Afterwards the scratch
themes were deleted, the slots and scheme put back, and the home removed.

## Gotchas

- The GUI's UI context `activeView` is the selection ("dashboard", "thread"), not the page
  on screen: a command that needs "the Themes page" gets it passed explicitly.
- Saving the same theme with only `pair` changed counts as applied (the slot shows it) and
  toasts again: two stacked toasts for a pair turn. Left as is: each says what changed.
- `vite preview` serves a production build, which ignores `?daemon=`: drive a real daemon
  from Playwright with the dev server.

## Left out

- The model cannot read the card's contrast report (the daemon derives no colours). It now
  tells the user to look at the card; a GUI-to-daemon report, or a CLI check, is a follow-up.
- The card's swatches show the base, not resolved slots or pins.
- No Apply on a card that was saved without applying.

## Daemon restart

Needed: the RPC, item kind, toast, `theme.ask`, the save's new lines and the skills (written at
daemon start). GUI and daemon ship together.
