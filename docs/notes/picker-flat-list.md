# New-thread picker: one flat ranked list, No project first, Add project pinned

Status: done on branch `cf/picker-flat-list` (off `main` at #366). Changes cmd+N's
project picker (`ProjectPicker`); the composer heading's `ProjectSwitcher` keeps its
groups.

## What changed

| Path | What |
|---|---|
| `gui/frontend/src/components/compose/ProjectPicker.tsx` | One flat list with no headings or separators: No project, then workspaces by name, then projects in registry order. `shouldFilter={false}`: the picker ranks the rows itself, and cmd+1..9 and their hints count the list on screen. The highlight is controlled and defaults to No project; Add a project is pinned below the scroll region |
| `gui/frontend/src/components/compose/useProjectRows.ts` | `usePickerRows` (the default order plus each row's search text, from narrow `useShallow` selectors), `rankPickerRows` (cmdk's `defaultFilter`), shared search terms (`projectSearchTerms`, `NO_PROJECT_TERMS`, `byName`) |
| `gui/frontend/src/components/compose/ProjectRows.tsx` | `ProjectRow`, `WorkspaceRow` and `NoProjectRow` are exported and all take an `index` for a cmd+number hint (`RowShortcut`). `ProjectRowGroups` is the switcher's grouped view; it drops the picker-only `shortcuts` and `soloHeading` |
| `ProjectPicker.test.tsx` | Rewritten: default order, ranking across kinds, cmd+N on the visible list, Enter on open, arrow reach of the pinned row, no-match and empty/loading states |
| `gui/frontend/e2e` | `fixtures.composeProject(page, n)` (clicks the nth `[data-project]` row) replaces the per-spec "cmd+N, cmd+<n>" helpers, because cmd+1 is now No project. `compose`, `no-project`, `buttons` and `addproject` specs assert the new order, ranking and highlight; the live specs click the first project row |

## Decisions

* **Ranking.** Each row has one search text: label plus keywords, joined with spaces the
  way cmdk joins value and keywords. Projects use name, path and source. Workspaces use
  name and member project names (sorted like the row's detail line). No project uses
  "No project", "home" and "~". cmdk 1.1.1 exports `defaultFilter`
  (command-score), so nothing is vendored. Rows that score 0 are hidden. Ties keep the
  default order (stable sort on index). The query is trimmed, and an empty query keeps
  the default order.
* **CommandEmpty still works with `shouldFilter={false}`.** cmdk's count becomes the
  number of mounted, non-`forceMount` items, so it is the number of visible rows. The
  pinned Add row is `forceMount` and does not count.
* **How the keyboard reaches the pinned Add a project row.** cmdk 1.1.1 moves the
  highlight, handles Enter and does `aria-activedescendant` only for items inside
  `CommandList`'s sizer (`listInnerRef`). An item rendered as a sibling of `CommandList`
  is visible but the keyboard cannot reach it. So `CommandList` here does not scroll
  (`max-h-none overflow-visible`). The rows sit in an inner div (`data-testid=
  "picker-rows"`) that has the old list's max height and scrolls. The Add row is a
  `forceMount` `CommandItem` after that div, inside `CommandList`. That gives:
  * it is visually pinned between the list and `picker-hints`;
  * in DOM order it is the last item, so Down from the last row reaches it;
  * with `loop`, Down from it wraps to the top and Up from the top wraps to it;
  * Enter, pointer hover and the a11y active descendant all work natively.

  No extra key hint was needed.
* **Highlight.** The Command's `value` is controlled: `value ?? fallback`. The fallback
  is No project (`HOME_KEY`) once projects have loaded and there is at least one.
  Otherwise it is Add a project, which covers both "not loaded yet" and "zero
  projects". The fallback follows loading until cmdk first reports a move (keys,
  pointer, a new query). A new query highlights the top hit (cmdk's select-first). A
  query that matches nothing leaves only Add a project, so it is highlighted. The old
  `initialValue()`, which highlighted the active thread's workspace or project, is gone.
  The picker never showed the "current" check, so nothing replaces it.
* **Empty state.** With zero projects, No project is still listed, because it still
  starts a thread. Add a project is the highlighted default. While projects load, the
  list shows "Loading projects…" and Add a project is highlighted.

## Gotchas

* Many e2e specs used "cmd+N, cmd+1" to mean "the first project". Under the new order
  that is No project, or a workspace when the mock has one. They now go through
  `composeProject`, which clicks the nth project row. The cmd+digit path itself is
  covered in `compose.spec.ts`, `no-project.spec.ts` and the unit tests.
* `addproject-workspace.spec.ts` "editing the path drops the question" failed once in a
  run of six specs. It then passed alone, 4x repeated alongside `addproject.spec.ts`, and
  in the full suite. It looks like load flakiness, not the picker.
