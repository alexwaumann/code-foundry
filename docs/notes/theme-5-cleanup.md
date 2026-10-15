# Theme 5: radio-group, skeleton, kbd and progress from shadcn; cleanup

Last of five PRs towards a theme engine (tokens, palette sweep, tooltip sweep, form
controls, radio-group + cleanup). The app's remaining hand-rolled copies of shadcn
primitives (radio tiles, pulse bars, eight key-chip stylings, a progress bar) are the
shadcn components now, styled once in `components/ui/`, and Radix is imported only
there. Frontend only.

## Components added

`pnpm dlx shadcn@latest add radio-group skeleton kbd progress` (shadcn 4.21.4, new-york,
radix-ui). `kbd` is in the registry for this style. Committed as generated first
(`b1100156`), the wrapper changes in their own commit after it.

| File | Change from the generated file | Why |
| --- | --- | --- |
| `kbd.tsx` | the app's chip look (hairline `border`, `bg-muted/60`, `text-muted-foreground`, `rounded`, no `font-medium`); `size` `default` (h-5, 11px) / `sm` (h-4, 10px); `variant="inherit"` (border and text in `currentColor`, 50% opacity, no fill); `data-variant`/`data-size` | one look for every key chip; the two sizes the call sites need; chips on filled or outlined buttons take the button's colour |
| `radio-group.tsx` | `RadioGroup` `variant` `default` (shadcn's grid) / `segmented` (the muted track); new `RadioGroupChoice`, an item that renders its children instead of the dot, `variant` `segment` / `tile`; checked styled from `aria-checked:` | the publish picker and the action editor show choices as segments and tiles, not dots. shadcn's `RadioGroupItem` always renders its indicator in place of any children, so `asChild` cannot carry a tile; a second item component keeps both looks in `ui/`, not at the call sites |
| `progress.tsx` | no `value` (null/undefined) = indeterminate: a third-wide indicator sliding across (`cf-indeterminate` in index.css) and no `transform`; with a value, shadcn's translate | the update store exposes no fraction (see Progress) |
| `skeleton.tsx` | none | `bg-accent` is `--muted`'s value in both schemes; shadcn's `rounded-md` replaces the bars' `rounded` |

Theme-engine prep: every new class is a token colour (the palette guard passes over
`ui/`), and state is styled from `aria-checked` (radio choices) or decided in React
(progress), never from Radix's `data-[state=…]`: a `Tip` around a control writes its own
`data-state` on the same element (theme-3/theme-4). `data-slot` and `data-variant` are on
every new part for a theme to target.

## Call sites

| Where | Was | Now |
| --- | --- | --- |
| `publish/PublishPicker.tsx` visibility | `RadioGroup` imported from `radix-ui`, items styled at the call site | `RadioGroup variant="segmented"` + `RadioGroupChoice variant="segment"` (same look, test ids, `Tip` hints) |
| `actions/ActionDialog.tsx` `IconTiles` | `div role="radiogroup"` of `button role="radio"`, manual `aria-checked`, a tab stop each, no arrows | `RadioGroup` (`grid-cols-6 gap-2`) + `RadioGroupChoice variant="tile"`: one tab stop, arrows move the choice (and wrap), Home/End move the focus; `data-testid="action-icon"`/`data-icon` kept; Cmd+Enter still saves from a tile |
| `pr/PullRequestSurface.tsx` loading | eight `div`s with `animate-pulse rounded bg-muted` | `Skeleton` × 8 inside the same `aria-busy`/`aria-label` container (`pr-loading`); the local component is `Loading` now |
| `linkedprs/LinkedPRsSurface.tsx` loading row | a pulse `span` | `Skeleton` (`linkedpr-loading`, `aria-busy` kept) |
| `update/UpdateDialog.tsx` | local `ProgressBar` (`role="progressbar" aria-busy`, sliding div) | `Progress` without a value, `h-1`, `aria-label` "Installing the update" / "Restarting", `data-testid="update-progress-bar"` |
| `help/HelpOverlay.tsx` `Keys` | `<kbd>` 11px, `text-foreground/80` | `Kbd` |
| `panel/SidePanel.tsx` surface list | `<kbd>` 11px | `Kbd` |
| `bottom/BottomPanel.tsx` "No terminals" | `<kbd>` 11px | `Kbd` |
| `compose/ProjectPicker.tsx` footer hints | `<kbd>` 10px, `text-foreground/80` | `Kbd size="sm"` |
| `compose/CompletionCard.tsx` footer hints | local `Kbd` (10px, border only) | `Kbd size="sm"` |
| `projects/ProjectsPage.tsx` filter's `/` | absolutely placed `<kbd>` 10px | `Kbd size="sm" className="absolute right-2"` |
| `thread/PendingPrompt.tsx` button hints | bare `<kbd>` styled by `.cf-thread .btn kbd` in thread.css | `ButtonKey` = `Kbd variant="inherit" size="sm"`; the thread.css rule is gone |
| `sidebar/SidebarToolbar.tsx` New thread chord | `<kbd>` 11px, `text-primary-foreground/60`, no border | `Kbd variant="inherit"` (not in the brief's seven: an eighth styling) |

### Kbd sizes and looks

- `default` (20px tall, 11px): a chord beside a list row or in the shortcut list (help
  overlay, side and bottom panel empty states, the sidebar's New thread).
- `sm` (16px tall, 10px): an inline hint in a footer, a field or a small button (picker
  and completion footers, the Projects filter, the permission/question prompt buttons).
- One colour: `text-muted-foreground` on `bg-muted/60`. The help overlay's and the project
  picker's chips were `text-foreground/80` and are a little dimmer now.
- `inherit`: the prompt buttons kept their look (currentColor hairline, dimmed; 50% for
  the old 45%). The sidebar's New thread chord gains the same hairline around ⌘N (it had
  none); seen live in both schemes, it reads as the same key chip as everywhere else.
- Not migrated: the Settings shortcut recorder (a button whose value is a chord, not a
  key chip), cmdk's `CommandShortcut` and the menus' `DropdownMenuShortcut` (shadcn's
  own trailing shortcut text in palette rows and menu items), and `<kbd>` inside
  rendered markdown (the guide, PR bodies: `.cf-markdown kbd` in index.css, em-sized to
  the text; GitHub's HTML can't use a component). index.css has two `.cf-markdown kbd`
  rules (the later one wins on padding, font and bottom border); left as is.

## Progress decision

`UpdateStatus.progress` (proto field 12) is "the installer's latest output line", a
string; the daemon reports no bytes or fraction, so there is no real `value` to give.
The dialog's bar stays indeterminate, now as the shadcn `Progress` with no value: Radix
renders `role="progressbar"`, `data-state="indeterminate"` and no `aria-valuenow`, and the
wrapper slides the indicator. The old `aria-busy` is dropped (it is not a progressbar
attribute; the missing value is what says indeterminate) and the bar has an
`aria-label`. Colours move from `foreground/10` + `foreground` to shadcn's `primary/20` +
`primary` (the same neutral in this palette). If the updater ever reports a fraction,
passing `value` makes it determinate with no other change.

## Guard: shadcn primitives only

`src/lib/tooltips.test.ts` gains "shadcn primitives guard" over every non-test `.ts`/`.tsx`
outside `src/components/ui/` and `src/gen/`, no allowlist:

- no `from "radix-ui"` / `@radix-ui/*` import (the wrapper in `ui/` is the only door);
- no `<kbd`, and no `role="radio" | "radiogroup" | "switch" | "checkbox" | "progressbar"`
  (hand-rolled copies of `Kbd`, `RadioGroup`, `Switch`, `Checkbox`, `Progress`);
- a self-test of both patterns.

`grep -rn 'from "radix-ui"' gui/frontend/src | grep -v components/ui` returns nothing.

## Audit: what stays bespoke

Grepped `gui/frontend/src/components` (outside `ui/`) for hand-rolled equivalents:

- **Inputs** (`<input`): the sidebar rename field (`SidebarRow`), the composers' hidden
  file inputs (`compose/Composer.tsx`, `thread/ThreadComposer.tsx`), the docked prompt's
  answer fields (`PendingPrompt`, two). Bespoke by decision (theme-4). No `<select>` or
  `<textarea>` remains outside `ui/`.
- **`role="switch" | "radio" | "progressbar"`**: none left (guarded).
- **`animate-pulse`**: only `pr/PrSummary.tsx`'s in-progress check icon, a pulsing status
  glyph, not a skeleton.
- **`role="separator"`**: three resize handles (`sidebar/ResizeHandle`,
  `panel/PanelResizeHandle`, `bottom/BottomResizeHandle`), interactive, not lines; and
  the thread's system note (`thread/rows.tsx` `.sysnote`), a labelled divider that shows
  its text, which shadcn's `Separator` (a bare line) does not.
  No plain-line separator to replace.
- **Tab strips** (`role="tab"`): the draggable strips in `SidePanel`/`BottomPanel`
  (dnd-kit, bespoke by decision) and `PullRequestSurface`'s `InnerTabBar` (Conversation /
  Timeline / Code). The last is not draggable and could be shadcn `Tabs` (it would gain
  arrow keys); listed as bespoke in the brief, so left for a follow-up.
- **Listboxes** (`role="listbox"`/`option`): the sidebar, PR, projects, workspace, linked
  PRs and overview lists (NavRow keyboard model, virtualized) and the composer's
  completion card (driven from the editor, focus stays in the composer). cmdk would take
  the focus; bespoke.
- **The snooze dialog's month grid** (`snooze/SnoozeDialog.tsx`, `role="grid"`): shadcn's
  `Calendar` would bring `react-day-picker` for one small picker; left.
- **Collapsibles** (`aria-expanded`, 16 sites): the virtualized sidebar/list sections and
  the thread's tool rows; bespoke by decision.
- Plain tables (usage, PR lists) and the cmdk palette input: bespoke by decision.

## Gotchas

- **Radix radio checks on arrow-key focus, a task later.** `RovingFocusGroup` moves the
  focus in a `setTimeout`; the item checks itself on that focus only while an arrow key
  is still down (a document keydown/keyup flag). Playwright's `press` sends keyup before
  the timeout on Chromium, so the focus moved and nothing was checked; the e2e holds the
  key 50 ms (`press(key, { delay: 50 })`). A person's key is down far longer; seen
  working live in WebKit.
- **One tab stop is the group.** Radix gives the `radiogroup` `tabindex="0"` and every
  item `-1` until one is focused; tabbing in hands the focus to the checked tile. With
  macOS "Keyboard navigation" off, WebKit's Tab skips buttons, so Tab out of the tiles
  goes nowhere in the dialog (the switch and buttons are not tab stops either); the old
  tiles were not tab stops at all there, the group (a `div` with a tabindex) now is.
- **Hover cascade on the tiles.** The old tile's dark `bg-white/[0.035]` beats
  `hover:bg-accent/50` (same specificity, later in the sheet), so unchecked tiles do not
  fill on hover in dark, only brighten their text. A `not-aria-checked:hover:` variant
  would have changed that (higher specificity); the wrapper keeps the plain `hover:` and
  the checked look overrides it with `aria-checked:` / `dark:aria-checked:`.
- `RadioGroupChoice` keeps pointer events when disabled (a `Tip` on a disabled segment
  still needs its hover).

## Tests

- Unit: `ui/progress.test.tsx` (new: indeterminate without a value, determinate with
  one); `actions/ActionDialog.test.tsx` (new: the tiles are one radiogroup, one tab stop,
  ArrowRight checks and focuses the next tile, Cmd+Enter then saves its icon; the
  existing "Cmd+Enter saves from an icon tile" passes unchanged); the guard above.
- e2e: `actions.spec.ts` (new: arrows, End, wrap, a click), `update.spec.ts` (the bar is a
  `progressbar` named "Installing the update", `data-state="indeterminate"`, no
  `aria-valuenow`). Specs that find `kbd` (buttons, help, linkedprs, worktree-panel,
  thread-prompts), the publish radios (create) and `pr-loading` (linkedprs) pass
  unchanged.

## Verified

- `make check` green (frontend 2928 tests; no Go change on this branch).
- `make gui-e2e` (WebKit + Chromium): 778 passed, 40 skipped, 0 failed; the known
  `panel.spec.ts` flake did not show. The tile hover/disabled tweak (`415be252`) landed
  during that run; `actions.spec.ts` and `create.spec.ts` rerun at the head: 32 passed,
  4 skipped. The new tile test passed 10 of 10 (`--repeat-each=5`, both browsers).
- Live (`make gui-build`, isolated `CODE_FOUNDRY_HOME`, a scratch repo under `~`, no
  Claude session; all deleted afterwards), dark and light:
  - Action editor (Projects page, project menu, New action…): Tab from Command lands on
    the checked tile (Play) with the focus ring; ArrowRight twice checks Lint; a click on
    Configure checks it; ArrowLeft from there checks Lint. The tile look matches PR 4's
    screenshot.
  - Publish dialog (not submitted): Public/Private segments, a click on Private, both
    schemes.
  - Help overlay, Keyboard shortcuts: every chip the `default` Kbd.
  - Side panel surface list (F / D / P chips), the Projects filter's `/`, the project
    picker footer, the composer's `@` completion footer, the sidebar's ⌘N chip.
- Not seen live: the bottom panel's empty-state chip (the Projects page cannot start a
  terminal and cmd+J in a thread starts one at once), the permission prompt buttons (no
  Claude session), the PR loading skeleton and the update dialog (no GitHub remote or
  release in the scratch setup). All covered by unit and mock e2e.
- Screenshots: `theme-5-cleanup/actions-dark.png`, `actions-light.png`, `help-dark.png`.
- No daemon change: no restart needed.

## Series summary

Five PRs (`theme-1-tokens.md`, `theme-2-palette.md`, `theme-3-tooltips.md`,
`theme-4-forms.md`, this note) leave the GUI ready for importable themes. A theme engine
can now rely on:

- **Tokens**: every colour is a CSS variable on `<html>` (`:root` / `.dark`): shadcn's set
  plus `success`, `warning`, `info`, `highlight` (each with `-foreground`),
  `destructive-foreground`, `link`, `pane`, `pane-border`, `sheet`; names follow shadcn's
  so published themes map one to one.
- **A theme root**: `data-theme` on `<html>` (`"default"` today), next to the `dark`
  class.
- **The terminal from CSS variables**: `--terminal-fg`, cursor, selection and
  `--terminal-ansi-0..15` (hex), re-read by xterm on any `class`/`style`/`data-theme`
  change.
- **No raw palette**: no Tailwind palette classes, arbitrary colours or colour literals
  outside a small allowlist of data colours (`palette.test.ts`).
- **One component per primitive**: tooltips, switches, selects, inputs, textareas,
  checkboxes, labels, radio groups, skeletons, key chips and progress bars are the shadcn
  wrappers in `components/ui/`, Radix only behind them (`tooltips.test.ts` guards native
  titles, direct Radix imports and hand-rolled copies).
- **State from aria**: controls style checked/unchecked from `aria-checked` (and
  `data-slot`/`data-variant` for targeting), not Radix's `data-state`, which a tooltip
  can overwrite.
