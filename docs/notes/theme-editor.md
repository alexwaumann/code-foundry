# Theme editor (2026-10-22)

PR 3 of 4 of the user themes series (1: hardening, #329; 2: themes as files, #328; 3: this,
the editor and the contrast report; 4: "Describe a theme", the model writes one). The
editor lives inside the Themes page: no new page, no new dependency.

## Step 0: main after #328 and #329

#328 and #329 were checked apart and merged back to back. `make check` on f995156a failed
once: `themes/convert.test.ts` found `internal/theme/catalog.json` (the daemon's copy of
the catalog, added by #328 from the converter before #329 changed Graphite Light's
overrides) out of date. Regenerated with `pnpm run themes` (first commit).

The user-theme path did not go through the catalog's rules, and the two sides disagreed:

| rule | GUI `parseThemeFile` before | daemon `theme.ParseFile` before | now (both) |
| --- | --- | --- | --- |
| override names | slots only | any `--cf-*`-shaped name | slots only (`IsSlot` reads `SlotNames()`, the regenerated frame defaults); a retired name says what replaced it |
| scheme vs surface | refused (OKLab L 0.45 / 0.70) | not checked | refused, same words and numbers (`SchemeProblem`, a colour conversion, not a derivation) |
| unknown fields | ignored | refused | refused |
| id | `^[a-z0-9][a-z0-9-]{0,63}$` (took `a--b`, `a-`) | single dashes | single dashes (`THEME_ID` tightened; PublishTheme's looser rule still takes all of them) |
| pair, name length, control characters, from, created_by, source length | not checked | checked | checked |
| source | required | optional | required in the catalog, optional in user mode (`parseThemeFile(json, { user: true })`) |

User themes from the events stream, the localStorage cache and the mock's `theme.save` now
go through `parseThemeFile` in user mode (`readUserThemeFile`); one the rules refuse is
dropped with a console warning. `pnpm run themes:check` reads files in user mode, since
that is what a model writes. `--cf-<tone>-text` pins are accepted everywhere;
`--cf-icon` and `--cf-sidebar-row-active` are refused on save ("was removed from the app;
pin --cf-sidebar-row-selected"). A file already on disk that pins one of those (written by
a tip build between the two PRs) still loads: `ParseStored` drops the retired pins on read,
the file is not rewritten, and its next save leaves them out.

## What shipped

- **`theme.edit <id>`** (`internal/command/commands_theme_edit.go`): ShowView
  `themes.edit.<id>`; the enum is the user's themes, read again at every call (palette and
  CLI). The Themes page's Edit (user rows) and Customise (copy with `theme.duplicate`, then
  `theme.edit` on the copy) call it. From the CLI it prints `editing <id> in the Themes page
  (windows=N)`. Like every ShowView it reaches every window.
- **Inspector** (sketch D), a 340 px column between the list (narrowed to 240 px, no
  swatch strips) and the gallery. Base: canvas, surface, text, accent, the five statuses as
  one row of swatches, link ("uses Info" when absent, clearable), and a collapsed Terminal
  row (foreground, cursor, cursor text, selection, 16 ANSI cells). Slots: a filter ("Filter
  102 slots", matching name, group, rule and uses), a Pinned only toggle (shadcn Toggle,
  added), then every slot by the registry's group in registry order, groups collapsible,
  Terminal and Syntax collapsed. A row: swatch over a checkerboard, the name without
  `--cf-`, the rule (or "pinned · would now derive #…" when stale), the value, a pin mark,
  a stale badge, a ratio badge on a failing slot; group headers count stale and contrast.
- **Slot view** (sketch E): back link, group, rule and "Used by …" (`SLOT_USES` in
  `src/themes/slotUses.ts`, held to the slot list by a test), derived beside yours painted
  on the surface it sits on (`SlotSample`: a sidebar row for sidebar slots, a dot, chip
  and, where the app paints one, a solid badge for status slots, text on a pane for text
  slots, a block and a line in the colour for the rest), the picker, the slot's contrast
  pairs with ratio and pass/fail, Reset to derived and Unpin. A base colour's view is the
  same picker with saved beside yours, what the rules make of it ("The rules make text
  #… from it"), and the pairs of the slot it feeds.
- **Picker** (`ColourPicker.tsx`): a lightness × chroma plane at the current hue drawn on a
  canvas from `oklchRgb` (pixels outside sRGB left empty), the shadcn Slider over drawn hue
  and alpha strips (Slider gained `trackClassName` / `rangeClassName`), hex and L / C / H
  (and A for a tint) fields. Arrow keys nudge the focused field or the plane, Shift ten
  times; Escape goes back. The hue is kept in the picker, so a grey keeps it.
- **Edit bar**: "Editing <name> · from <from> · unsaved", Revert, Save…, and × to close the
  editor. The gallery paints the draft (only its scope's inline slots change; the gallery
  element is memoised); the window keeps its theme until Save.
- **Save… modal** (sketch F): name (a rename keeps the id), "From X · scheme · N slots
  pinned", the problems (each failing slot at its worst pair with Fix, each stale pin with
  Re-derive), "You can save anyway", "Use as my dark/light theme now" (checked when the
  theme's scheme is in use; replaced by a line when the theme already is that slot's), and
  "Save and apply" / "Save". The editor stays open on the saved file.
- `src/themes/contrast.ts`, exports: `contrastReport`, `slotContrast`, `derivedValue`,
  `withoutPin`, `staleOverrides`, `pinBasis`, `fixContrast`, types `EditableTheme`,
  `ContrastEntry`, `StalePin`. Built on `CONTRAST_PAIRS` / `contrastFailures`;
  `contrastPairs.ts` now shares `pairRatio`, `pairBackground` and `pairLabel`.
- `theme.save` (and `theme.duplicate`) print `contrast: checked in the editor (theme edit
  <id> shows failing pairs and stale pins)` after the pinned count. The daemon derives no
  colours, so it cannot count failures or stale pins; porting `contrastFailures` to Go was
  ruled out with derivation.

## The stale rule

A pin is an absolute value: a base change never moves it. Stale means the base has moved
what the slot would derive since the pin was made. The editor keeps a basis per pin: the
slot's derived value when the pin is made (`pinSlot` records it the first time) or, for the
pins already in the file, when the editor opens it (`pinBasis`). `staleOverrides(theme,
basis)` resolves the theme with that one pin removed (the other pins kept, since they feed
the rules after them) and reports the pins whose derived value differs from their basis.
Comparing the pin with the derived value instead would mark every pin stale (a pin
differs from its rule by definition). Back to the old base, the pin is not stale again.
Re-derive unpins; Reset to derived pins the new derived value and moves the basis to it.
The basis is session state: reopening a saved file starts clean.

## Fix

`fixContrast(theme, slot)`: if the slot is pinned and its derived value passes every pair
it is drawn in, unpin; otherwise step its lightness (hue and chroma kept, 0.005 a step, as
`ensureContrast` does) away from the failing pair's background until every pair it is drawn
in holds, the other way if that runs out, and pin the result (a tint keeps its alpha). It
acts on the slot drawn on top, also when the background is the pinned one.

## The save path

One path: `runCommandForResult("theme.save", { data: <file JSON>, apply })`. The JSON is
`themeFileJson(draft)`, the daemon's field names (`created_by`, no empty optionals), since
`ParseFile` refuses unknown fields. `apply` is theme.save's own flag, which writes the slot
setting the way `theme.set-dark` / `theme.set-light` do, in the same call. The written
file arrives back on the events stream like any other change.

## Leaving

Clicking another row, the arrows, the other slot chip, Customise on another theme, the ×,
Escape, view.back, opening Settings, Usage or another page, and a sidebar selection all
go through `afterLeavingEditor` / `setPages`: clean, the editor just closes; with unsaved
edits the standard confirm dialog asks ("… has changes that are not saved") and Cancel
leaves everything as it was. However the page closes, a views-store subscription drops the
editor. Deleting the theme being edited closes the editor without asking.

## Gotchas

- `useEscapeCloses` is a capture-phase window listener, so a field's own Escape handler
  runs after it. The page passes `closeOrBack` (back from a colour's view, else close);
  fields are skipped by the hook and handle Escape themselves.
- The live-slot guard (`liveSlots.test.ts`) counts the editor's samples as readers, so the
  status sample paints a solid badge only for warning and error, whose `-foreground` the app
  uses; the others stay pages-only.
- The tooltip guard refuses any `title=` prop, including a component's own prop named
  title (renamed `heading`).
- `ratioText` rounds down (two decimals under 2:1), so a 4.48 never prints as "4.5:1" and
  1.27 against a 1.25 floor does not print as "1.2:1".
- A theme file edited on disk while the editor is open is not merged: the editor keeps its
  draft and Revert goes back to what it opened or last saved.

## Left out

- "Also make a light pair" (PR 4: the model makes it).
- A list of failing slots on the theme's row in the list (the sketch's footnote).
- Virtualising the slot list: 102 rows in collapsible groups, Terminal and Syntax closed.

## Verified

- `make check` green on the combined tree (Step 0) and on this branch.
- New tests: Go `TestSchemeProblem` (lightness and messages pasted from the GUI's),
  `TestIsSlot`, `TestParseStoredDropsRetiredSlots`, ParseFile cases (unknown, retired, `-text`
  and terminal slots, scheme), `TestRetiredSlotPinIsDropped` (store), `TestThemeEdit`;
  frontend `contrastReport.test.ts`, `themeEditor.test.ts`, parseThemeFile user mode and
  `themeFileJson`, the API mapping refusing a retired pin and a wrong scheme. e2e:
  `theme-editor.spec.ts` (3: open, base change repaints the gallery and not the window, pin,
  stale after a base change, slot view and Reset to derived, Pinned only, save with "use
  now" and a rename, revert; Customise and the leave confirm; a contrast failure and Fix),
  `user-themes.spec.ts` (Customise now opens the editor), `themes.spec.ts`.
- The built app on an isolated `CODE_FOUNDRY_HOME`: CLI `theme edit` and the GUI editor end
  to end (shots in the PR body). The daemon must be restarted: `theme.edit`, the stricter
  `ParseFile` and the save output are daemon code.
