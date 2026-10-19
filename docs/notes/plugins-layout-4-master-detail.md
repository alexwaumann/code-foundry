# Plugins layout 4: master-detail and node tabs (2026-10-19)

PR 4 of the plugin layout series (PR 1: `plugins-layout-1-columns-pane.md`). A list
beside the chosen row's detail that degrades to list-then-detail in the side panel, and
a tab strip any container can hold.

## What shipped

| Part | Where |
|---|---|
| `MasterDetail{List, Selected, Detail, ListWidth, EmptyDetail, ResetToken}`, `TabsNode{Tabs, Children}` (`Node.MasterDetail`, `Node.Tabs`), the numbers, `MinNodeTabs`; `NewMasterDetail`, `NewTabsNode`; `ActSelect`, `SurfaceAct.Node` | `pluginsdk/ui/ui.go`, `build.go`, `pluginsdk/protocol.go` |
| Validation: list (as any list), listWidth range, selected is "" or a row, empty detail (an empty node's limits), resetToken, node tabs (2..8, active, keys, labels, badges), detail and children one container deeper; embedded `Tabs` named by its JSON path in the UTF-8 walk | `pluginsdk/ui/validate.go` |
| Host: walks the detail and the tabs node's children (`Children`), `[]` lists, a row without an action is a `select` element and a node tab a `tab` element, both naming their node (`SurfaceElement.node`, proto field 7), empty-detail buttons act; capabilities `view.node.masterDetail`, `view.node.tabs` | `internal/store/plugin/surface.go`, `surface_act.go`, `proto/`, `internal/api/plugin_surface.go` |
| GUI: types, `childLists`/`withChildLists`, `nodeScope` (draft scope), `walkScoped`, scoped `formsOf`, narrow state (`details`, `reconcileDetails`, `openDetail`/`closeDetail`), `LeavingNode`, `MasterDetailNode`, `TabsNode`, `TabStrip` (shared with the view's tabs), `RowView` exported with `onActivate`/`selected`, `VirtualStack` honours `[data-virtual-root]` | `api/plugin.ts`, `stores/pluginSurfaces.ts`, `components/plugin/` |
| Hello demo **Runs** tab (key `run-list`): the Layout tab's six runs in a master-detail; a run's detail is its facts and a tabs node (Overview: markdown and a note form; Log: a 240 px pane with the run's log); fixture `hello-demo/run-list.json` (nothing chosen), the other six gained the tab; the mock patches the choice in | `plugins/examples/hello/runs.go`, `gui/frontend/mock/plugins.ts` |
| Skill: `ui-layout.md` sections (breakpoint, narrow flow, act shapes, nested tabs vs sections, list/detail pattern), primitives links and act rows, limits rows | `internal/skills/` |

## Decisions

* **Act shapes.** A row without an `action` sends
  `{"kind": "select", "action": "select", "key": "<row>", "value": "<row>", "node": "<master-detail>"}`;
  a node tab sends the view's tab act with the node named:
  `{"kind": "tab", "action": "tab", "key": "<tab>", "value": "<tab>", "node": "<tabs node>"}`
  (`node` is `""`, left out, for the view's own tabs, so old plugins see no change). The
  plugin answers with a view whose `selected` / `active` is the new one, as with view
  tabs. A row with an event action sends its click instead (and chooses the row); a
  command, URL or copy row runs on the host and is not chosen. A client value never
  replaces the key, and `find` by action alone never matches a tab or a select.
* **Optimistic selection with revert.** The chosen row reads as selected while its act is
  pending (`pending[watchKey][rowKey]`), the detail on screen dims (`opacity-60`,
  `aria-busy`) and its live nodes let go (`LeavingNode`); a failed act clears the
  pending flag, so the selection is the plugin's `selected` again, and the narrow layout
  goes back to the list. The tabs node does the same for its tab.
* **Breakpoint**: wide when the node's own measured width is at least
  `listWidth + 12 + 320` (612 px by default). Unmeasured counts as narrow, so the panel
  never flashes two sides. The panel at its default width is always narrow.
* **List width** 200..400 px, default 280 (`MasterDetailListWidth`); the detail's least
  width beside it is 320 (`MasterDetailMinDetail`); gap 12 (`ColumnGap`). Wide, each side
  scrolls on its own (`overflow-y-auto`, `overscroll-contain`) and the node's max height
  is the rest of its fill box below its top (`useNodeHeight(..., "fill")`, floor 240).
* **Caps**: no new row cap; rows, empty-detail buttons and node tabs count toward the
  view's 400 elements. Node tabs: 2..8 (`MinNodeTabs`..`MaxTabs`; a view's tabs may have
  one). The empty detail has an empty node's limits (2 buttons). Both nodes are containers
  for `MaxDepth` (message lists `masterDetail, tabs`). Neither is a strip kind.
* **Narrow "showing detail" state** lives in the surface store (`details`), keyed by
  `draftKeyOf(instance, viewTab + outer scopes, nodeKey)`, so it survives re-renders,
  remounts and the panel widening and narrowing again, and is per view tab. Choosing a
  row opens it (recording the resetToken and selected row as seen); Back closes it
  (nothing is sent; focus returns to the row, as it went to Back on open). On each new
  view `reconcileDetails` closes it when `resetToken` changed or `selected` became
  something that is not a row (`""` included), and records a change to another row (the
  detail stays open on it). A node the new view does not show keeps its entry (another
  view tab may show it again). A failed choice closes it.
* **Nested tabs name**: the node kind is `tabs` (`TabsNode` in Go, since `Tabs` is the
  view's type, which it embeds: `{"key", "tabs": {"items", "active", "children"}}`). It is
  drawn one step smaller than the view's strip, in the list (not pinned).
* **Draft scoping**: a form's draft key is `instance, viewTab + nodeScope..., formKey`,
  where a tabs node adds `\u0001<key>=<active>` and a master-detail `\u0001<key>=<selected>`.
  So the same note field keeps one draft per run and per node tab; reset tokens and
  submit settling use the same scoped keys.
* **Live-node budget in a hidden side**: the hidden side is not drawn at all (narrow shows
  either the list or the detail), so a thread or terminal in a detail holds no stream
  while the list shows; `INLINE_LIVE_MAX` (2) is unchanged. A pending choice or node tab
  switch lets the old content's live nodes go, like a pending view tab.

## Tests

* Go SDK (`masterdetail_test.go`): a table for every validation branch of both nodes
  (bounds, selected, keys shared with the node, detail and view tabs, rows' own actions,
  empty detail limits, reset token, tabs count/active/labels/badges, children), UTF-8 in
  an embedded tab, elements at 400/401, JSON shapes and round trip, `Children`. PR 1's
  reflection tests caught the two kinds (23 kinds) and containers until registered;
  `TestLayoutNumbersMatchTheGUI` checks 280, 320, 12 and the range against `layout.ts`;
  a fuzz seed nests tabs and a pane in a detail to the limit.
* Daemon: the `every` view has both (`md1` select, `md2` click, `mde` click, `tn1/tn2`
  tab); `TestMasterDetailAndTabsWalked` (canonical `[]`, element kinds and nodes, an
  append to a log in a tab in a detail, refusals); `TestSurfaceSelectAndNodeTabActs`
  (the acts the plugin gets, a client value ignored, select as click refused,
  `SurfaceElements` carry the node).
* Hello: `runs_test.go` (select, node tab, note per run, refusals).
* Vitest (`masterdetail.test.tsx`, 26): numbers, walks and scopes, reconcile, narrow
  (list, select act with pending selection, revert on failure, already selected, event
  rows, host-action rows, remount per view tab, reset token and plugin-driven reselect
  through the store, inert, empty text), wide (612 px rule and resizes, custom width,
  empty detail, height cap, dimming), live nodes under `LeavingNode`, tabs node (strip,
  pending/revert, inert, drafts per node tab and row), the demo fixture. `plugin.test.ts`
  now parses all seven demo views.
* e2e `plugins.spec.ts` (WebKit, 12 passed): the Runs tab is narrow in the panel; a row
  click sends the select, shows the detail under Back (focused, titled); the detail's Log
  tab sends a node tab act, shows the 240 px pane, and the Overview draft survives the
  trip; Back returns to the list with the row selected and focused and sends nothing;
  widening past 612 px puts a 280 px list beside the detail (12 px apart, each
  `overflow-y: auto`); choosing another run there swaps the detail in place.

## End to end (isolated `CODE_FOUNDRY_HOME=~/.cfpl4`)

```
make build plugins
CODE_FOUNDRY_HOME=~/.cfpl4 ./bin/code-foundry daemon --dev &      # without CLAUDE* vars
code-foundry settings set threads.default_model 'claude-haiku-5-5[1m]'
code-foundry plugin dev plugins/examples/hello --yes --follow=false
code-foundry thread new --no-project --name "Runs master-detail" --created-by=
code-foundry plugin act hello demo tab --key run-list --context-thread s-be73157e0c75
code-foundry plugin surface hello demo --thread s-be73157e0c75 --settle 2s --json
cd gui/frontend && vite --port 9381   # WebKit (Playwright) at /?daemon=…&token=…
```

`plugin surface` listed the six rows as `select` elements and the view validated.
Screenshots (dark and light, `plugins-layout-4-master-detail/`): the panel at its default
width with the list, then Build #5 alone under its back button (facts, the node tabs,
the note form), then the panel widened by 420 px with the list beside the detail on its
Log tab. The light list shows Build #5 marked: the plugin kept the dark pass's choice.
No messages were sent (the context thread's idle process was the only Claude process);
the daemon and vite were stopped and `~/.cfpl4` removed.

## Gotchas

* The fixture stays captured with nothing chosen: the mock patches the choice into it and
  returns early when nothing is chosen, so a capture with a run chosen (tried by the
  first agent) would show that run before any act. A tabs node therefore appears in no
  captured view; `plugin.test.ts` says so and the other tests cover it.
* The first agent was stopped mid-task and left a daemon on `~/.cfpl4` running an older
  build; it was stopped and the home recreated before the screenshots.
* A wide list side scrolls on its own, so `VirtualStack` needed `[data-virtual-root]`
  ahead of the surface's `[data-scroll-root]`, else it virtualized against the body.
* Only `e2e/plugins.spec.ts` ran (WebKit, one worker on its own ports), per Alex; no full
  `make gui-e2e`.
