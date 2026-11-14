# Shell 8: the host seam

PR 8 of the shell plan (`docs/notes/shell-plan.md`, sections 2.11 and 4). It is a refactor:
the side panel and the bottom panel behave exactly as before.

## What changed

`gui/frontend/src/shell/host.ts` is now the only way surfaces and the code around them reach
their tabs. For now every operation delegates to `stores/panel.ts`. Moved onto the seam: the
surface specs and their target codecs (`surfaces/*`), the surface stores (`filePanel`,
`fileEdit`, `fileFind`, `fileFinder`, `fileRequest`, `prPanel`, `mcpPanel`, `mcpTabs`,
`pluginPanel`, `pluginTerminals`, `emberPanel`, `recentFiles`, `workspaceActions`), and the
components that used the store (`DiffView`, `useFileHold`, `PullRequestSurface`, `prLinks`,
`PluginSurface`, `PluginSurfaceRows`, `EmberPane`, `ProjectsPage`, `ThreadComposer`,
`FileFinder`, `useFileFinder`).

`src/shell/host.guard.test.ts` fails when a source file outside the allow-list imports
`stores/panel` (static, re-exported, type-only or dynamic `import()`). Tests and `src/test/`
helpers are exempt: they set up and inspect the classic store, which is still the
implementation they test.

## The seam's API, and why

I built the API from what the importers actually call, not from the plan's list.

- **Identity**: `Tab`, `SurfaceKind`, `tabId`, `makeTab`, `pullRequestTabId` are re-exported.
  A tab is `{id, kind, title, params}` in both the classic panel and the shell, so the target
  codecs (`*Target.ts`) only change where they import from.
- **Targets**: `TabTarget` (a string: `"current"`, `thread:<id>`, or a page's or composer's
  key), `targetOf(selection)`, `threadTarget(id)`, `threadOfTarget(target)`,
  `useCurrentTarget()`. These are the panel's keys today. `pane:<id>` from the plan is not
  added: nothing asks for a pane yet, and PR 11 adds it with the shell half.
- **Reading**: `TabPlace` is what a surface reads about the tabs under a target: `shown`,
  `expanded`, `tabs`, `groups` (each with its tabs and its `active` tab), and `focused`. It
  leaves out what only the panel draws from: width, ratio, the picker's `pickFrom`, and
  `GroupIndex`'s 0|1 shape. `tabPlace(target)`, `findTab(target, id)`, `shownTab(place)` and
  `groupOfTab(place, id)` read it now. `useTabPlace(target, select)` is the narrow selector
  hook, and `subscribeTabs((now, prev) => …)` is for the stores that drop per-tab state when
  a tab goes. `tabChanges` is the `Subscribable` for a `SurfaceSpec.watches`. This replaces
  the plan's `findTabs` and `useTab`: no caller wanted one tab by id as a hook. They select
  over a place instead: are there File tabs, does a group show the board, is the panel
  expanded.
- **Writing**: `openTab` (with `group` and `behind`, as `openSurface` had), `activateTab`,
  `retitleTab`, `setTabParams` (params, or a function of the old ones: this one entry point
  replaces `setPanelTabParams`, `setPanelTabParam` and `dropPanelTabParams`; the file
  surface's `withoutParams` builds the drop), `replaceTab`, `showTabs` and `expandTabs`.
  `closeTab` is not added: every close goes through the panel's own gestures today, and no
  surface closes its own tab.
- `showTabs` and `expandTabs` are classic-panel ideas that surfaces still ask for: the
  checkout diff and the workspace instructions show the panel without focus, Ember's Board
  button hides it, and a loose file in a narrow window expands it. The shell will map them:
  "shown" is always true in a pane, and expanded is close to the spec's full screen. They are
  on the seam so the callers do not change again.

### Identity and narrow selectors

`TabPlace` is made once per panel entry object (a `WeakMap`), and the record of places
(`TabPlaces`) once per `byKey` object. A place therefore keeps its identity until its own
target's tabs change, so `useTabPlace` selectors and the `recentFiles` "same entry, skip"
check work as they did on raw entries. `subscribeTabs` fires only when `byKey` changes. The
panel store's state is `byKey` alone, so that is every real change, as before.

## What stayed on the store (the allow-list)

- `components/panel/*`: the side panel.
- `components/bottom/*`, `stores/bottomPanel.ts`, `stores/bottomActions.ts`: the bottom
  panel. Its keys are the side panel's, and it hides or un-expands the side panel.
- `stores/views.ts`, `stores/threadPanelIntent.ts`: the `view.panel.*` commands and the
  daemon's panel intents.
- `stores/archiveCleanup.ts`: resets a put-away thread's side and bottom panel entries. In
  the shell, this is the layout's job (PR 6, daemon side), so it is not a seam operation.
- `App.tsx`: the classic window. An expanded panel hides the content pane.

## Gotchas

- `subscribeTabs` and `TabPlaces` build a place for every entry, so a malformed entry (one
  with no `groups`) now throws inside the store listener. Rehydrated state always goes
  through `sanitizePanelState`, so only a test seed can do this; one in
  `bottomActions.test.ts` used `{ open, expanded } as never` and now seeds a real entry.
- `unsavedTabs(panelKey, tabs)` takes the tabs, not a `PanelEntry`. `archiveCleanup` passes
  `allTabs(entry)`.
- `newlyShownFiles` and `pruneClosedMcpTabs` take places. Their pure tests build `TabPlace`
  literals.
- `pluginTerminals.useInVisibleBottom` used to read the selection with `getState()` inside the
  panel selector. It now subscribes to the target with `useUiStore`, like `usePanelExpanded`.
  It already re-rendered on a selection change through `bottomKeyOf`.
- `SurfaceContext.panelKey` keeps its name. It is a target now, and renaming it would touch
  every surface for no gain before the shell lands.

## For later PRs

- PR 11 adds the shell half: with the shell flag on, each function here goes to the layout
  client, and `TabTarget` gains `pane:<id>`. A thread target means "this thread's linked tabs
  in its space", and `TabPlace.groups` are the panes holding them.
- `openTab`'s `group` is only passed by the panel's surface list (`SurfaceRow`,
  `PluginSurfaceRows`). In the shell, that list is the pane's "+" menu, so `group` becomes the
  pane.
- `SurfaceSpec.beforeClose` and `useUnsaved` still take `(panelKey, tab)`. Keep that
  signature: it is the target.
- PR 21 deletes the classic half and the allow-list entries with it. The guard should then
  allow nothing but the seam, or the file should go once `stores/panel.ts` is gone.
