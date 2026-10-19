# Plugins layout 1: columns and pane (2026-10-19)

PR 1 of the plugin layout series. Plugin surfaces render in the side panel (about 360 px)
today and in main-pane pages later, so every container says how it degrades to one
column and one view model serves both.

## What shipped

| Part | Where |
|---|---|
| `Columns{Items, Collapse}`, `Column{Key, Weight, Width, Children}`, `Pane{Height, MinHeight, NoScroll, Children}`, `Node.Children()`, `MaxLiveNodes`, the columns constants | `pluginsdk/ui/ui.go` |
| `NewColumns`, `NewColumn` (+ `WithWeight`, `WithWidth`), `NewPane` | `pluginsdk/ui/build.go` |
| Validation: kinds, 2..4 columns, weight 1..6 / width 160..640 / not both, collapse, pane height and minHeight, depth by containers | `pluginsdk/ui/validate.go` |
| Host walks (logs, acting elements, owned nodes, `[]` lists) through `Children()`; capabilities `view.node.columns`, `view.node.pane` | `internal/store/plugin/surface.go`, `surface_act.go` |
| GUI types, `childLists` / `withChildLists` (every walk), renderers, width hook, fill boxes | `api/plugin.ts`, `stores/pluginSurfaces.ts`, `components/plugin/{layout.ts,list.ts,height.ts,NodeList.tsx}`, `nodes/{ColumnsNode,PaneNode}.tsx` |
| Hello demo **Layout** tab (columns of a pane with a log and a list beside markdown and pairs; a collapse-first pair with the assistant thread in a fill pane), fixture `hello-demo/layout.json` (the other five gained the tab) | `plugins/examples/hello/layout.go` |
| Skill: `reference/ui-layout.md` (new; primitives.md is at 29 KB of the 32 KB cap), primitives.md links it, limits table rows | `internal/skills/` |

## Decisions

* **Gap 12 px** side by side (`ColumnGap`, `gap-3`, the design system's pane gap).
  Stacked, the columns use the gap of the list around them (12 px at the top level, 6 px
  inside a section) and so do the nodes inside a column or pane (`list.ts` context), so
  a stacked columns node reads as one list.
* **Side by side when the node's own width ≥ Σ max(240, fixed width) + 12 × (n − 1)**:
  2 columns 492 px, 3 744, 4 996. The brief said "items × 240"; counting the gaps and a
  fixed column wider than 240 keeps every weighted column at its 240 px minimum
  (`min-width: 240px`, `flex: <weight> 1 0`), and a narrow fixed column still needs 240 so
  the panel at its default width always stacks. Fixed columns are `flex: 0 0 <w>px`.
  Side by side the columns stretch to the tallest.
* **Measured, not a media query**: one ResizeObserver per columns node on its own root
  (`useElementWidth`); null (not measured) stacks, a hidden (0 px) node keeps its last
  width. The width comes from the parent, so toggling the layout never feeds back.
* **Collapse**: `stack` (default) or `first` (only column one; the others are not
  rendered at all, so their live nodes hold no stream).
* **Pane scroll is `NoScroll bool`**, not `Scroll bool` defaulting to true: Go's zero
  value, like `Log.NoFollow`. Panes draw no border or background.
* **Fill semantics** (`height.ts` `fillBoxOf`, `fillHeight`): a fill node (thread,
  terminal, pane) takes its box's height below its own top. Its box is the nearest
  enclosing pane with a px or fill height (`data-fill-box`), else the surface's scroll
  area (less its 16 px bottom padding; a pane leaves none). Auto panes, sections and
  columns are not boxes. Floors: 240 px for threads and terminals, a fill pane's
  `minHeight` (240 when unset). A box smaller than the floor scrolls (or cuts with
  noScroll). Two fill nodes in one box do not share it. Measured on layout and on the
  box's resize, as before for threads and terminals; nested fill panes chain (the inner
  observes the outer). `minHeight` above a px height is refused.
* **Depth**: `MaxDepth = 4` now counts containers (section, columns, pane) a node sits
  inside, so `section > columns > pane > section > node` is the deepest; a column is part
  of its columns node. The old meaning (node levels, 3) allowed two sections; every old
  view still passes. The message names them: `inside 5 containers (section, columns,
  pane), at most 4`.
* **Elements**: a column counts (it has a key); `MaxElements` stays 400.
* **Live streams: not raised.** The brief asked for `INLINE_LIVE_MAX` 6 and
  `MAX_OPEN_STREAMS` 8. The GUI reaches the daemon over HTTP/1.1, where WebKit and
  Chromium hold 6 connections per origin, and every stream holds one. Measured on the
  mock (a view of six thread nodes, both browsers): with 8 slots, 6 streams opened and the
  next act hung (`Click` never reached the plugin); with 5 the act completed and two nodes
  said "Waiting for a connection". Raising only the inline budget would trade the
  Paused/Attach control for nodes stuck waiting. So both stay (2 and 5); `ui.MaxLiveNodes`
  documents the 2 and a Go test keeps it equal to `INLINE_LIVE_MAX`. Six live nodes need
  more connections first: serve thread and terminal streams from a second loopback origin
  (`localhost` beside `127.0.0.1`, same listener) with its own slot pool. Left for its own
  PR before page layouts with several threads.

## Tests

* Go (`pluginsdk/ui/layout_test.go`): every `Node` kind field counts in the one-kind check
  (reflection; a new kind fails until validated and listed); every container kind (a kind
  holding `[]Node`, found by reflection) is nested to `MaxDepth` and one past, mixed, and
  walked by `Children`; a layout table for every validation branch; columns as elements
  at 400/401; JSON shapes and builders; `TestLayoutNumbersMatchTheGUI` (240, 12, live 2 vs
  `layout.ts` / `live.ts`). `FuzzView` seeds come from `viewSeeds()` and
  `TestFuzzSeedsCoverEveryKind` fails when no seed has some kind (a layout seed nests every
  container to the limit). The daemon's `every` view has columns and a pane;
  `TestLayoutContainersWalked` checks `[]` lists, indexing and appends inside them.
* Vitest: `layout.test.tsx` (the rule, collapse, styles, rendered stack/row under widths
  with resizes, collapse first, hidden width, inner spacing, nesting, pane modes, fill in
  px/fill/auto panes and a thread in a pane in a column, floors, fill boxes), registry
  (the Layout tab), store walks (append in a pane in a column keeps other lists'
  identity, forms, unknown kinds), `childLists`/`withChildLists`, fuzz with the Layout tab
  and the new numbers.
* e2e `plugins.spec.ts`: the Layout tab stacks in the panel (pane 320 px, scrolling),
  then side by side after widening the panel (12 px gap, weight 2:1), collapse first adds
  the thread, which fills its fill pane.

## End to end (isolated `CODE_FOUNDRY_HOME=~/.cfpl1`)

```
make build plugins
CODE_FOUNDRY_HOME=~/.cfpl1 ./bin/code-foundry daemon --dev &      # without CLAUDE* vars
code-foundry settings set threads.default_model 'claude-haiku-5-5[1m]'
code-foundry plugin dev plugins/examples/hello --yes --follow=false
code-foundry thread new --no-project --name "Layout columns" --created-by=
code-foundry plugin act hello demo tab --key layout --context-thread s-05651f3f8904
code-foundry plugin surface hello demo --thread s-05651f3f8904 --settle 2s --json   # the fixture
cd gui/frontend && vite --port 9381   # WebKit (Playwright) at /?daemon=…&token=…
```

Screenshots (dark and light, `plugins-layout-1-columns-pane/`): the panel at its default
width (stacked; the summary only), then widened (side by side; the assistant thread in
its fill pane). No messages were sent; the daemon was stopped and `~/.cfpl1` removed.

## Gotchas

* Another agent reset this branch in the shared worktree mid-task; the work survived
  uncommitted and moved to its own worktree. Commit early in shared worktrees.
* `react-refresh/only-export-components`: the list spacing context lives in `list.ts`,
  not `NodeList.tsx`.
* `SKILL.md` has a 120-line cap besides the 32 KB per-file cap.
* The hello fixtures are captured views: the Layout tab's ids and opened time were set to
  the other five's so the mock's time shift and id patches apply alike.
