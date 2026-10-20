# Side panel split, PR 1 of 3: tab groups in the panel store

Agreed with Alex on 2026-10-20 (the design and a mockup built from the real app were
reviewed first). The feature lets a side panel hold two tab groups, each with its own
strip, active tab, picker and "+". This PR changes only the store model
(`gui/frontend/src/stores/panel.ts`) and its callers. **No visible change**: the GUI
still renders the first group only, and nothing in the app can split a panel yet.
PR 2 renders the groups (orientation, the divider, `view.panel.split`); PR 3 adds dragging
a tab between groups.

## The model

```ts
PanelGroup = { tabs, activeTabId, pickFrom? }
PanelEntry = { open, groups /* 1 or 2 */, width?, expanded?, ratio?, focused?: 0 | 1 }
```

* **`groups`**: one group, or two when split. Group 0 is the top or left one, group 1 the
  bottom or right one. A tab id is in at most one group, so ids stay unique per panel.
* **`ratio`**: the share of the split's axis group 0 takes. Absent means 0.5, and the
  reducers drop it when set back to 0.5 (like `expanded`). Clamped to 0.2..0.8. It is
  kept when the split collapses, so the next split comes back at it. The store does not
  know the orientation: PR 2 derives it from the rendered width, and the same ratio
  applies to either axis.
* **`focused`**: the group the user last interacted with. Absent means 0, and it is
  always absent on an unsplit panel (`focusedGroup(e)` reads 0 there anyway).
* **Picking per group**: `isPicking(e, g = focused)` is true for a group with tabs and no
  active tab, as before, and also for an **empty group of a split panel** (the picker a
  single-tab split starts with). An unsplit panel without tabs is still not picking: the
  list shows anyway, and cmd+w hides the panel there.

## Rules

* **Open** (`openTab(e, tab, group?)`, `openSurface(target, tab, { group })`): a tab
  already open in either group is activated where it is (title and params refreshed) and
  that group takes focus. A new tab goes to `group`, or the focused group when none is
  given; group 1 on an unsplit panel means 0. The tab's group ends picking and takes
  focus. The other group is untouched.
* **Close** (`closeTab`): the per-group rules are the old ones (neighbour activation,
  `pickFrom` moving). A group losing its last tab collapses the split: the other group
  takes the panel, `focused` is dropped. Only when the whole panel has no tabs left does
  the old last-tab rule apply: hide, unless `keepOpen` (appearance.panel_keep_open).
* **Split** (`split`): picking in the one group ends first (back to `pickFrom`). The
  active tab moves into a new group 1, which takes focus, and group 0 activates its right
  neighbour, else the left one. With a single tab the tab stays and group 1 starts
  empty and picking, focused. A panel without tabs, or an already split one, is
  unchanged.
* **Unsplit** (`unsplit`): group 1's tabs are appended to group 0's. The focused group's
  active tab stays active; if it is picking, its `pickFrom`; if it is empty, the other
  group's active tab (or `pickFrom`). Picking ends. Width, expanded and ratio stay.
* **Move across** (`moveTabToGroup(e, id, group, toIndex?)`): the tab is inserted at
  `toIndex` (clamped, default last), made active there (ending that group's picking),
  and that group takes focus. The source group loses it as `closeTab` would take it. If
  that empties the source, the split collapses into the target. On an unsplit panel,
  moving to group 1 splits it (PR 3's drop band); moving its only tab changes nothing.
  The tab's own group with `toIndex` is `moveTab`.
* **Picking**: `startPicking(e, g)` and `stopPicking(e, g)` default to the focused group
  and focus the group they act on. `stopPicking` on an empty group of a split panel
  collapses the split, with focus on the remaining group.
* **Focus**: `focusGroup(e, g)`; 1 on an unsplit panel changes nothing. Open, activate,
  start/stop picking, split and moves set it as above. Close, retitle and in-group moves
  do not: PR 2 calls `focusPanelGroup` when the user interacts with a group.
* No empty, non-picking group ever exists in a split panel: every path that empties a
  group collapses it.

## Store API and selectors

* New: `splitPanel(target, { focus })` (shows a hidden panel, asks for focus like
  `startPanelPicking`, returns whether the panel is now split), `unsplitPanel`,
  `movePanelTabToGroup`, `setPanelRatio` (undefined resets), `focusPanelGroup`.
* `startPanelPicking(target, { focus, group })` and `stopPanelPicking(target, group?)`
  take a group, defaulting to the focused one. `closePanelTab`, `activatePanelTab`,
  `movePanelTab` and `retitlePanelTab` find the tab's group by id.
* Selectors: `usePanelGroup(key, g)` (the group object, stable until it changes; the
  empty group for group 0 of a panel without an entry, undefined for a group 1 it does
  not have), `usePanelSplit`, `usePanelRatio`, `usePanelFocusedGroup`, and
  `usePanelPicking(key, g?)`.
* Helpers for callers: `isSplit`, `focusedGroup`, `groupAt`, `groupOf`, `allTabs`,
  `activeTab(e, g?)`, `emptyGroup`, `RATIO_DEFAULT/MIN/MAX`.

## Callers (behaviour unchanged)

* `SidePanel.tsx` renders group 0 (`usePanelPicking(key, 0)`, the strip and body read
  `groups[0]`). Its keys act on the focused group (`surfaceKey` uses `activeTab(e)`),
  which is group 0 until PR 2 can split.
* `keys.ts` `panelKeyAction` acts on the focused group: cmd+w closes its active tab,
  hides the panel when it has none, and stops picking while it picks (which collapses an
  empty group 1).
* `filePanel.ts` `lastTabOf` and `prPanel.ts` (pruning PR tab state) look at
  `allTabs`, so a tab in group 1 counts. `emberPanel.ts` treats the board as shown when
  it is the active tab of either group.

## Migration

The persist version goes from 2 to 3. `migratePanelV2` moves the flat `tabs`,
`activeTabId` and `pickFrom` into `groups[0]` and keeps `open`, `width` and `expanded`. A
version 1 store goes through `migratePanelV1` (on the flat shape, now typed
`PanelEntryV2`) first. Zustand writes the migrated state back as version 3 right after
hydrating. Downgrades are not handled (releases never downgrade).

## Decisions and deviations from the brief

* **Pure reducers `split` and `unsplit`**, not `splitPanel`/`unsplitPanel`: the brief named
  both the reducers and the store API that way, and one module cannot export both. The
  store functions keep the brief's names, following `toggle`/`togglePanel`.
* **Split while picking ends picking first.** The brief did not cover it. Moving the
  `pickFrom` tab is what the user would see as "the active tab", so `split` goes back to
  it and moves it.
* **Unsplit ends picking**, landing on the focused group's `pickFrom` when it was picking.
* **`activateTab` on the already active tab of the other group** returns a new entry (focus
  moves), not the same one. On an unsplit panel it is still the same entry.
* **Group 1 on an unsplit panel is group 0** for `openTab`, `startPicking` and
  `stopPicking`, rather than a no-op or an implicit split. Only `moveTabToGroup` splits.
* **Two e2e expectations changed** (`archive.spec.ts`, `snooze.spec.ts`): they read the raw
  stored entry after archive/snooze reset it, so the shape is in the assertion. Behaviour
  is the same.
* New tests live in their own file (`stores/panel.groups.test.ts`); `panel.test.ts` only
  changed its helpers to the new shape and gained the `migratePanelV2` table.

## Gotchas

* `noUncheckedIndexedAccess` is on: read groups through `groupAt(e, g)` (never undefined)
  instead of `e.groups[g]`, except in selectors that need the stored object.
* Tests that spread an old entry with `activeTabId:` (`{ ...p, activeTabId }`) still
  typecheck through `setState` and silently do nothing. `linkedprs.test.tsx` had one;
  it now calls `activatePanelTab`.

## Tests

* Vitest: 5263 tests in 250 files (was 5141 in 249), all green. `stores/panel.test.ts`
  132 (+7: the `migratePanelV2` table, every key, a version 2 rehydrate saving version
  3). `stores/panel.groups.test.ts` 115 (new): helpers, `isPicking` per group, and tables for
  open, close (with keep-open), retitle, activate, move in a group, move across groups,
  split, unsplit, start/stop picking, focus, ratio; the store API, persistence, and the
  selectors through `renderHook`. Other test files only changed the entry shape.
* `make check` green. `make gui-e2e` (WebKit, mock daemon): 489 passed, 26 skipped (the
  SHOTS-gated ones among them), no retries.
