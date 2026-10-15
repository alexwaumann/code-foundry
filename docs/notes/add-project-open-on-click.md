# Add Project dialog: a click on a folder opens it; only Enter and Add project add

Status: done on branch `t3code/local-project-folder-navigation` (off `main` after #99).
Users clicked a folder in the Local folder tab's suggestions to look inside it, and the
click added that folder as a project. Frontend only; the daemon is unchanged.

## What changed

| Path | What |
|---|---|
| `gui/frontend/src/components/palette/pathCompletion.tsx` | `PathSuggestions` takes an optional `onOpen(name)`. With it, a click hands the row to `onOpen` and Enter still to `onPick`; each row draws a muted `ChevronRight` (after "already added") that shows only while the row is hovered or highlighted. Without it nothing changes |
| `gui/frontend/src/components/addproject/LocalFolderTab.tsx` | A click opens the folder (`descendInto`, error cleared, focus back in the input). The "Add ~/path" row is gone; a hidden first item stands for "no folder highlighted" so Enter adds the typed path. Hint: "Click or Tab opens a folder · Enter adds" |
| `gui/frontend/mock/world.ts` | `dev.path` (Developer, "Echo Path"): one required path arg, so e2e can reach the palette's path prompt |
| `gui/frontend/e2e/addproject.spec.ts` | Click opens (also an already added folder), the chevron, Enter on a highlighted folder, Enter after a click adds the typed path, the button adds the typed path, no "Add ~/" row |
| `gui/frontend/e2e/paths.spec.ts` | The palette's path prompt still runs the command with a clicked folder, and draws no chevron |

## Decisions

* **The palette is unchanged.** Its path prompts pick a command argument (a terminal's
  cwd, a worktree), not a project, and picking a folder there is the point. Only the
  dialog changes for now. `onOpen` is opt-in, so the palette can take the same
  behaviour later by passing it.
* **Click vs Enter inside `PathSuggestions`.** cmdk calls `onSelect` for both. A row's
  `onClickCapture` runs before cmdk's own `onClick` on the same click event and sets a
  ref; `onSelect` reads and clears it. Enter goes through cmdk's custom
  `cmdk-item-select` event, which has no click phase. This is plain DOM event order, so
  WebKit and Chromium behave the same, and the API stays `onPick` (Enter) plus
  `onOpen` (click) rather than the dialog handling Enter on its own.
* **A hidden item instead of "no value".** cmdk re-highlights the first item after every
  search change (the input is cmdk's, so every keystroke and every opened folder is one),
  and when the highlighted item unmounts. A `value` that matches nothing is reset on the
  next keystroke, and a controlled `value` cannot tell cmdk's auto highlight from an
  ArrowDown on the first row. So the list starts with a `hidden` (display: none) item,
  `__typed`: cmdk highlights it by default, no folder looks highlighted, Enter on it adds
  the typed path, and the empty-path error still shows. ArrowUp from the first folder
  returns to it, which reads as "back to the input". `highlightedEntry()` finds no
  `data-entry-name` on it, so Tab still completes and `/` is just typed.
* **Hovering highlights, so Enter after a hover adds the hovered folder.** That is cmdk's
  pointer selection and was already so; typing (or opening a folder) moves the highlight
  back to the typed path.
* **Chevron with opacity, not display.** It keeps its space, so "already added" does not
  shift when a row is hovered. `group-hover` plus `group-data-[selected=true]` on the row.

## Verification

* `make check` green.
* `addproject.spec.ts` + `paths.spec.ts`: 30/30 on WebKit and Chromium.
* `make gui-e2e` (WebKit + Chromium): 734 passed, 28 skipped, 0 failed, first run.
* Built app (`make gui-build`) on a scratch daemon (`CODE_FOUNDRY_HOME=~/.cf-openclick-scratch`):
  a click on `Documents` opened `~/Documents/` and added nothing; a click on the
  already added `code-foundry` opened `~/projects/code-foundry/`; ArrowDown + Enter on a
  folder in `~/projects/` added that folder (toast "Added ai", two projects: it and the
  one registered from the CLI beforehand). The hover chevron shows on the row under the
  pointer even before the pointer moves (`group-hover`), and on the highlighted row.
* Screenshots: `add-project-open-on-click/dark.png`, `light.png` (built app, a folder row
  highlighted so the chevron shows).
* Not verified live: Enter with nothing highlighted and the Add project button (both
  covered against the mock in `addproject.spec.ts`); the native folder picker (unchanged
  code). The palette's path prompt is covered only against the mock, through the
  mock-only `dev.path`: no daemon command prompts for a path in the palette today.

## Gotchas

* **`getByText` counts hidden elements.** The hidden `__typed` item has no text, or a
  `getByText(/^Add ~\//)` "row is gone" check matches it.
* **`toBeVisible` ignores opacity.** The chevron test reads `opacity` with `toHaveCSS`, and
  moves the mouse away first: after a click the pointer still hovers a row of the new
  listing, which `group-hover` would light up.
* **Worktree build** needs `third_party/ghostty-vt` copied from the main checkout with the
  `.pc` prefix rewritten, as in the earlier add-project PRs.
* **The live check writes into the real app's panel state.** Adding a project selects it
  and opens its tab in the Projects page panel (localStorage, shared with the installed
  app). The scratch project's tab was closed before quitting; the theme was switched with
  `settings set appearance.theme` against the scratch home, so nothing else leaked.
