# No sidebar override, PR 1 of 2: the GUI (2026-11-01)

Undoes the option parts of `hidden-children-2-gui.md`. PR 2 (the daemon, in parallel)
drops `Thread.in_sidebar`, `thread.sidebar`, `thread.new --sidebar` and
`threads.show_created_threads`; this PR makes the frontend stop reading or offering any
of them, so PR 2's regenerated types compile against it.

## Decision (Alex, 2026-11-01; not up for debate)

A thread another thread created is never in the sidebar, and there is no way to pull it
out: no setting, no per-thread override (T3 Code has no such control either). The one
rule, `lib/inSidebar.ts`:

    inSidebar(t, byId) = !t.createdBy || byId[t.createdBy] === undefined

A thread is in the sidebar iff it has no creator or its creator no longer exists (not in
the thread list at all). That second case replaces the daemon's persisted orphan adoption
(an override set on removal), so nothing is stored: the rule follows the list. To take
over a child's work the user forks it or starts a new thread; children stay reachable
through the creator's thread info card (its lineage group), the palette and links.

## What was removed

* `ThreadView.inSidebar` and its mapping (`api/threads.ts`); the proto field still exists
  on this branch and is simply not read.
* `stores/settings.ts`: `KEYS.showCreatedThreads`, `showCreatedThreadsOf`,
  `getShowCreatedThreads`, `useShowCreatedThreads`; `dockAlerts.ts` no longer compares the
  key.
* `THREAD_COMMANDS.sidebar`, `setThreadSidebar`, `toggleThreadSidebar`
  (`stores/threadActions.ts`), `useSidebarShown` (`stores/lineage.ts`), the
  `thread.sidebar` presenter and its `paletteSupplied` entry (`keys/bindings.ts`).
* The thread menu's Show / Hide in sidebar item (`ThreadMenuItems.tsx`; the sidebar row
  menu and the header title menu share it).
* The lineage label menu's "Show hidden threads" checkbox (`LineageGroup.tsx`), which
  wrote the setting. The menu keeps its disabled "Archive finished" placeholder, so the
  ellipsis (and its hover rule from #455) is unchanged. The Threads-tab Eye/EyeOff buttons,
  the "hidden" word and the header `SidebarButton` were already gone with the Threads tab.
* Every `showCreated` parameter: `threadFocus`, `sidebarAnchor`, `useThreadListKeys`,
  `encodeThreadListKey`, `getListThreads`, `attentionIds`, `runningCount`,
  `useAttentionCount`, `jumpToNeighbour`, `jumpTo`, `jumpToAttention`, `focusThread`.
  They read the threads store's `byId` instead.

## Decisions made while building

* **`byId` is the lookup.** `ThreadsData.byId` holds every thread the daemon lists:
  archived ones (the Archived footer reads them) and owned ones (plugin and resident
  threads, which `order` leaves out). So an archived creator, Ember or a plugin thread
  still exists and keeps its children out of the sidebar; only a removed creator frees
  them. The rule takes the record (`ThreadsById`, membership only), so selectors pass
  `s.byId` and stay primitive.
* **The sidebar list key** carries the hidden flag computed with `byId`, so a creator's
  removal rebuilds the list (the creator's own key leaves too) and its children appear at
  once. `encodeThreadListKey(id, x, byId)`.
* **`sidebarAnchor`** now always finds a row for a known thread except in a creator cycle:
  walking `createdBy` ends at a thread with no creator or one whose creator is gone, both
  shown.
* **Removal still cascades in the mock.** The daemon removes (and archives) the hidden
  threads below a thread with it, and with no override every child is hidden, so removing
  a creator takes its whole tree. The "creator gone" case then comes from a cascade that
  skipped a child or older data. The mock gains `POST /__mock/thread/forget?id=` (one
  thread alone, no cascade) to produce orphans; `World.inSidebar` is the new rule and the
  archive cascade no longer stops at shown children. Whether PR 2 keeps the remove cascade
  is PR 2's call; the GUI needs nothing either way.
* **The archive confirmation** in the mock drops the hand-over advice ("ask … to hand it
  over (code-foundry thread sidebar --shown=true)"): "N child threads are still working;
  archiving ends their turns and archives them too." The real text is the daemon's (PR 2).
* **Pages**: the mock bridge page no longer passes `sidebar: true` to `thread.new`; its
  thread is the page thread's child and gets no sidebar row. The pages skill
  (`internal/skills/files/code-foundry-pages`) still documents `sidebar: true` in
  SKILL.md, verbs.md, examples.md and welcome.md: that is the daemon's verb, left to PR 2.
  Only `reference/sources.md`'s `inSidebar` field was dropped here, because
  `api/bridgeSourcesDoc.test.ts` checks it against `ThreadView`.
* **Docs**: GETTING-STARTED's paragraph on created threads now says to fork or start a new
  thread; ARCHITECTURE's GUI paragraph states the rule. The daemon paragraph is PR 2's.

## Gotchas

* `POST /__mock/thread/<action>` routes only the actions in `control()`'s regex; the old
  `thread/sidebar` was never in it (dead). `forget` is, and it answers before
  `threadSummary`, which would 404 on the removed thread.
* Opening a child in e2e now goes through its creator's card (`ti-lineage-row`): the
  `child` thread-info scenario and the live-count nested lead have no sidebar rows.
* The live check runs this GUI against the pre-PR-2 daemon, which still cascades a
  removal through hidden children. To see an orphan there, the child was given the old
  override first (`code-foundry thread sidebar --shown=true`, which the GUI now ignores:
  the child stayed out of the sidebar), so the removal skipped it.

## Tests

* Unit: `lib/inSidebar.test.ts` (no creator, creator present, creator archived, creator
  removed; `threadFocus` and `sidebarAnchor` with an orphan), `stores/context.test.ts`,
  `stores/dockAlerts.test.ts` (an orphan counts; a removed creator makes a waiting child
  badge and bounce), `stores/intents.test.ts`, `RowMenu.test.tsx` and
  `ThreadMenuItems.test.tsx` (no sidebar item on a child).
* e2e: `lineage.spec.ts` (out while the creator exists, in with ↳ and "(removed)" once it
  is forgotten, the orphan's own row highlighted, cmd+shift+a / cmd+1..9, no Show / Hide
  in any menu, no "Show hidden threads", the archive takes every child),
  `sidebar-subagents.spec.ts`, `thread-header.spec.ts`, `thread-info.spec.ts`,
  `bridge.spec.ts`.
