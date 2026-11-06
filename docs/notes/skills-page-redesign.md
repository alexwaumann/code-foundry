# Settings → Skills redesign (2026-11-05)

Installed rows were about 130px tall and could not be searched, so with many installed the
search in Browse sat thousands of pixels down. This PR gives Settings → Skills one catalog
layout, which Settings → Plugins takes on next. GUI only: no Go, proto or migration change.
It supersedes the page layout in `skills-4-gui.md`; that note's reasoning for the chips, the
daemon's confirms and the settings search still holds.

## What is here

| Piece | Where |
|---|---|
| Shared layout: toolbar, chip, card, group header, row, switch | `components/settings/catalog/` |
| Flat list ids, word match, the header's and field's words (pure) | `components/settings/catalog/model.ts` |
| The page: modes, query state, Update all, notices | `components/skill/settings/SkillsPage.tsx` |
| Installed and marketplace rows | `components/skill/settings/SkillRows.tsx` |
| Groups, row main action, row menu, page menu words (pure) | `components/skill/settings/model.ts` |
| Registries as a dialog | `components/skill/settings/RegistriesDialog.tsx` |
| Update all's sequence | `stores/updateRun.ts` |
| The switch (no confirm, warning toast) | `stores/skillConfirm.ts` `setSkillEnabled` |
| A file outside any project in a panel | `stores/filePanel.ts` `openLooseFile` |

## Decisions

* **One flat list.** Group headers and rows are one array for `VirtualStack`, so a long
  Installed list is virtualised like the marketplace. A store selector returns flat string ids
  (`#needs`, keys) for `useShallow`, so a re-read that moves nothing does not redraw the list.
* **Groups.** Needs you takes any row with an update, setup to run or a missing folder, also
  when it is disabled: the rule is the design's, with no exception for the switch. A local skill
  counts as Enabled.
* **Main action order.** Update comes before Run setup (an update can change the script);
  `rowMain` picks one. Run setup returns once the update is done.
* **Search.** The Installed group filters in the client at once; the marketplace waits the
  150 ms debounce. An installed row has no keywords, so a row the daemon found by keyword also
  joins the Installed group (dbt-model for "sql"), and a hit shown there is not listed twice.
  The marketplace count is the daemon's total less those hits, and the header keeps "showing
  the first N". `searchedText` says what the current answer answers: until the first answer the
  store still holds the whole marketplace, which must not read as hits for the words typed.
* **Tier chips and nothing found.** The one-line "Nothing installed or in your marketplace"
  replaces the card only with no tier chip on. With one on, the group header stays, or the chip
  that caused it could not be turned off.
* **Browse all shows what the search limit allows.** The list is the daemon's answer at
  `SKILL_SEARCH_LIMIT` (200; the daemon caps it at 500, and Search has no offset), so past that the header
  says "showing the first 200" and the rest are reached by searching. Paging is a daemon change.
* **Switch.** `busy` holds what the command asked for, so the switch flips at once and a failure
  reverts by itself. On success the store marks the row before the re-read, or it would flick
  back in between. `skill.disable` keeps its daemon confirm for the palette and CLI; from a
  switch it is answered yes (the page's preconfirm) and the success toast is replaced by one
  carrying `RESTART_WARNING`.
* **Update all.** The existing `updateSkill`, one row at a time, quiet (three stacked toasts said
  what the rows say). A failure does not stop the run. A finished row stays in Needs you reading
  "Updated to X" until the page is next opened. A single Update click is not part of a run: its
  row moves to its group at once. A failed one reads "Retry update" either way, from the row's
  failure.
* **Menus.** `OverflowMenu` and `RowContextMenu` from the Projects pages, with a new `hint` line
  on items (the page menu's "Read 5 min ago"; why Run setup again is disabled) and `tabbable`,
  since Settings has no list cursor to reach them. Run setup again is also left off a missing
  skill: its script went with the folder.
* **View SKILL.md needs no daemon change.** `ReadFile` takes any absolute path under home or a
  temp folder, and a File tab with project "" reads by path, as a workspace's instructions do. So
  any panel can hold it: `openLooseFile` opens it in the selection's panel. Selection `none`
  (which draws the home composer but has no panel key) selects `HOME` first, and a window too
  narrow for a panel beside the content expands it. If `CLAUDE_CONFIG_DIR` is outside home and
  temp, or the folder is a symlink out of them, the File tab shows the daemon's refusal: the
  existing path limit, left as it is.
* **Registries.** No longer a page section. The settings search's Skills › Registries hit opens
  the dialog and Skills › Browse all presses the toggle: `SettingsPage` passes the hit's section
  to the page, which mounts with it. Installed stays `data-section="installed"` on the card.

## Verification

* Vitest: `model.test.ts`, `SkillsPage.test.tsx`, `stores/updateRun.test.ts`,
  `stores/skillConfirm.test.ts`, `stores/filePanel.test.ts`, `SettingsPage.test.tsx`.
* `e2e/skills.spec.ts` keeps what needs a browser: virtualisation and a row measured in place,
  Escape in the dialog, the context menu at the pointer. SHOTS makes the PR's screenshots.
* `make drive`: default, search, chips, nothing found, Browse all, both menus, Update all with an
  injected failure, Retry update, the switch.
* `make drive DAEMON=dev` with a scratch `CLAUDE_CONFIG_DIR` under home and a scratch directory
  marketplace: View SKILL.md from the home composer, Pull Requests, Projects and selection `none`
  (the File tab rendered it and Settings closed); Update all across two real skill updates; the
  switch disabling with no confirm, the warning toast, and the folder moved to
  `<home>/skills/disabled`.

## Gotchas

* `updateSkill` during Update all is a row action: a row already busy returns false with no
  failure, so it is neither marked updated nor failed.
* `make drive` in the background needs `make -C <checkout>`: a background shell may not start in
  the checkout.
