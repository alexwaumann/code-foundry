# Plugins layout 2: grid and inline nodes (2026-10-19)

PR 2 of the plugin layout series (PR 1: `plugins-layout-1-columns-pane.md`). Four node
kinds: `grid` (a container), `divider`, `spacer` and `group` (leaves on one line).

## What shipped

| Part | Where |
|---|---|
| `Grid{MinWidth, Items}`, `GridItem{Key, Span, Children}`, `Divider{Label}`, `Spacer{Size, Flex}`, `Group{Items, Align, NoWrap}`, `AlignCenter`/`AlignBetween`, the constants, `Children()` for grid and group | `pluginsdk/ui/ui.go` |
| `NewGrid`, `NewGridItem` (+ `WithSpan`), `NewDivider`, `NewSpacer`, `NewFlexSpacer`, `NewGroup` | `pluginsdk/ui/build.go` |
| Validation: minWidth, 1..24 items, span, divider label, spacer size, 1..8 group items of the allowed kinds, align; depth (grid is a container) | `pluginsdk/ui/validate.go` |
| Canonical `[]` for grid items' children and group items; capabilities `view.node.grid`, `.divider`, `.spacer`, `.group` | `internal/store/plugin/surface_act.go` |
| GUI types, `childLists`/`withChildLists`, `gridColumns`/`gridSpan`/`spacerSize`, `BoxList`, renderers, shadcn `Separator` | `api/plugin.ts`, `components/plugin/{layout.ts,list.ts,NodeList.tsx,PluginSurface.tsx}`, `nodes/{Grid,Divider,Spacer,Group}Node.tsx`, `components/ui/separator.tsx` |
| Hello demo Layout tab: a Grid divider, a grid of five cards (minWidth 200, one span 2), an Inline groups divider, two groups, a bare divider, a card whose 180 px pane pins its bar with a flex spacer, a 24 px spacer; recaptured `hello-demo/layout.json` | `plugins/examples/hello/layout.go` |
| Skill: `reference/ui-layout.md` (grid, divider and spacer, group, limits, patterns), primitives.md section, limits table rows | `internal/skills/` |

## Decisions

* **Grid columns** = `min(6, max(1, floor((width + 12) / (minWidth + 12))))` on the node's own
  measured width (PR 1's `useElementWidth`; null stacks). `minWidth` 160..480, 0 = 240. At
  240: 2 columns from 492 px (as for columns), 3 from 744; the panel at its default width is
  1 even at 160 (328 px of content needs 332). Equal `minmax(0, 1fr)` tracks, 12 px both ways.
  **The count is not capped at the item count** (CSS auto-fill, not auto-fit): two items on
  a wide page keep a card's width instead of becoming two half-page cards.
* **Span** 1..2 (0 = 1), clamped to the column count (so it is 1 when stacked). Rows fill in
  order, no dense packing (a span-2 item that does not fit moves to the next row).
* **One column is a plain stack** with the gap of the list around it (12 px top level, 6 px
  in a section), like stacked columns.
* **An item's only node stretches** to its row (`[&>:only-child]:grow`), so a row of card
  sections lines up; an item with several nodes keeps their heights. Not in a spec, but cards
  of uneven height in one row looked broken.
* **Items**: 1..24 (an empty grid is refused; show an `empty` node). A grid item counts as
  an element, like a column; a grid counts one container level, its items none. Depth
  message: `inside 5 containers (section, columns, pane, grid), at most 4`.
* **Divider**: shadcn `Separator` (added; there was none). With a label: rule, label in
  `text-overline` (already muted), rule; the label truncates. A blank label is a bare rule.
* **Spacer size** 4..64, 0 = 12, added **on top of the list gap**: the spacer takes back one
  gap with a negative top margin (`-mt-3` / `-mt-1.5`, none when first), so between two nodes
  there is `gap + size` (24 px by default at the top level), whatever the list's gap.
* **Flex spacer box rule**: it grows only in its box's own list: the surface's top-level list
  or the list of a pane with a px or fill height (PR 1's fill boxes). `NodeList box` provides
  a `BoxList` context and grows to the box (the surface's root and body became `grow`
  flex columns for this); every other `NodeList` (section, column, grid item, auto pane)
  resets it, so a flex spacer there is its fixed size. When the box's nodes already fill it
  the spacer is its size too.
* **Group allowed kinds: text, chips, actions, progress.** Others are refused with `a group
  holds text, chips, actions, progress nodes, not <kind>` (the refused item's key still
  counts, so duplicates are still caught). Pairs, lists, markdown, notices, empties, logs are
  blocks; containers, dividers, spacers and groups do not nest. Items are content-wide and
  shrink; progress grows from a 160 px basis. 8 px gap, centred vertically. 1..8 items
  (`MaxGroupItems`, my choice; the brief named none). Items count as elements; a group is not
  a container (its items sit at its depth) — the reflection test now has `lineKinds` beside
  `containers` for "holds nodes but is no level".
* **Names**: `Group`/`group` (no clash in Go, JSON or the GUI). Wrap is **`NoWrap bool`**
  (json `noWrap`), not `Wrap` defaulting to true: Go's zero value, as with `Pane.NoScroll`.
* **Align** reuses `ui.Align`, now with `AlignCenter` and `AlignBetween`; an actions bar still
  takes only start and end (its message now says so).
* Gap constants: `GridGap = ColumnGap` (12), `GroupGap` 8; `TestLayoutNumbersMatchTheGUI`
  also checks `GRID_MIN_WIDTH`, `GRID_MAX_COLUMNS`, `GRID_GAP`, `GRID_MAX_SPAN`,
  `SPACER_SIZE`, `GROUP_GAP`, the minWidth range and the spacer range.

## Tests

* Go: `grid_test.go` (a table row per validation branch of grid, divider, spacer, group;
  actions align; elements at 400/401 for grid items, group items, dividers and spacers;
  JSON shapes and round trips); `layout_test.go` reflection tests (20 kinds; grid in
  `containers`, group in `lineKinds`, a group at the deepest level validates and is walked);
  `gridSeed` fuzz seed (grid nested to the limit, a group of every allowed kind, both
  dividers, fixed and flex spacers); builders in `TestBuilders`; the daemon's `every` view
  has all four and `TestGridAndGroupWalked` checks `[]` lists, indexing of a button and a
  chip in a group, appends to a log in a grid item, and the refused kind; limits rows and
  ui-layout content checked in `internal/skills`.
* Vitest: `grid.test.tsx` (formula at every threshold and the cap, minWidth fallback, span
  clamp, stack before measure, inner gap, widen/narrow with resizes, hidden width, only-child
  stretch, empty grids, containers inside; divider forms; spacer size, margins, flex in the
  surface/px/fill lists and fixed in section/auto pane/column/grid item/non-box list; group
  classes, aligns, noWrap, unknown align, empty, unknown kind), registry (the Layout tab's new
  nodes), store walks (append in a grid item, forms in a grid, unknown nodes in a group),
  `childLists` for grid and group, fuzz with the new optional fields and numbers.
* e2e `plugins.spec.ts`: the grid stacks in the panel (span-2 card one column wide), the
  divider label is centred, the between group's ends touch the group's edges on one line,
  8 px between group items, progress at least 160 px, the flex spacer pins the bar to the
  180 px pane's bottom, the fixed spacer is 24 px; after widening, `data-columns` equals the
  formula for the measured width, 12 px gap, the span-2 card is two columns plus the gap,
  cards in a row are equally tall. WebKit and Chromium, all 20 plugin cases green.

## End to end (isolated `CODE_FOUNDRY_HOME=~/.cfpl2`)

As PR 1: `make build plugins`, daemon `--dev` without `CLAUDE*` vars, Haiku 5.5 default,
`plugin dev plugins/examples/hello`, `thread new --no-project`, `plugin act hello demo tab
--key layout`, `plugin surface ... --json` (the fixture's nodes; header, ids and time kept
from the old capture so the mock's patches apply), then vite on 9381 and Playwright WebKit
at `/?daemon=…&token=…`. Screenshots (`plugins-layout-2-grid-inline/`): the panel at its
default width (grid in one column) and widened by 480 px (3 columns, span-2 deploy card).
No messages were sent; daemon and vite stopped, `~/.cfpl2` removed.

## Gotchas

* `pluginsdk` is Go 1.24: no `new(expr)` in its tests.
* `scrollIntoView` puts a node under the surface's sticky header; scroll the scroll root by
  the header's bottom instead when screenshotting.
* `@typescript-eslint/no-unnecessary-condition` rejects `record[key] ?? fallback` on a
  `Record<Union, string>`; type the map `Partial<Record<string, string>>`.
* The machine was under heavy load from parallel agents (eslint alone took minutes).
