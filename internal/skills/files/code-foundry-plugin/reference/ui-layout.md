# Layout: columns, panes, grids and inline nodes

Container nodes arrange other nodes: **columns** (side by side), **pane** (a box with its
own height and scroll) and **grid** (cards in as many columns as fit). **divider**,
**spacer** and **group** (leaves on one line) space and line up nodes without a
container. A surface shows in the side panel (about 360 px wide, the user can widen it)
and, later, in pages of the main pane: one view serves both, so every container says how
it degrades to one column. Check `h.HasCapability("view.node.columns")`
(`view.node.pane`, `view.node.grid`, `view.node.divider`, `view.node.spacer`,
`view.node.group`) before sending them: an older host refuses the view.

## columns

```json
{"key": "run", "columns": {"collapse": "stack", "items": [
  {"key": "run-main", "weight": 2, "children": [{"key": "run-log", "log": {"text": "…"}}]},
  {"key": "run-side", "children": [{"key": "run-facts", "pairs": {"items": []}}]}]}}
```

```go
run := ui.NewColumns("run",
	ui.NewColumn("run-main", logNode).WithWeight(2),
	ui.NewColumn("run-side", factsNode), // weight 1
)
run.Columns.Collapse = ui.CollapseStack // the default; ui.CollapseFirst drops the others
```

- **2 to 4 columns.** A column has a `key` (in the view's one namespace; it counts as an
  element) and `children`, and either a `weight` (1..6, absent = 1: a share of the width
  the fixed columns leave) or a fixed `width` (160..640 px), not both.
- **Side by side** when the node's own width is at least 240 px a column (a fixed column
  wider than that: its width) plus 12 px between columns: 2 columns need 492 px, 3 need
  744, 4 need 996. Side by side the columns are 12 px apart, top-aligned and as tall as
  the tallest; a weighted column never gets less than 240 px.
- **Narrower** (always the case in the side panel at its default width) the node degrades
  by `collapse`:
  - `stack` (default): the columns one under another, in order, spaced like the list
    around them. Put the column the user needs first first.
  - `first`: only the first column; the others are not drawn. For detail that only makes
    sense on a wide page (a thread beside a summary) when column one is a complete
    summary on its own. Keys in dropped columns still count and still act from the CLI.
- The width is measured live: widening the panel past the threshold puts the columns side
  by side, narrowing it stacks them again. Do not render different views for panel and
  page; the plugin is not told which one it is in.

## pane

```json
{"key": "out", "pane": {"height": 320, "children": [{"key": "out-log", "log": {"text": "…"}}, {"key": "out-list", "list": {"rows": []}}]}}
{"key": "chat-box", "pane": {"height": "fill", "minHeight": 320, "noScroll": true, "children": [
  {"key": "chat", "thread": {"threadId": "s-1f2e3d4c5b6a", "height": "fill"}}]}}
```

```go
out := ui.NewPane("out", ui.HeightPx(320), logNode, listNode)
chat := ui.Node{Key: "chat-box", Pane: &ui.Pane{Height: ui.HeightFill, MinHeight: 320, NoScroll: true,
	Children: []ui.Node{{Key: "chat", Thread: &ui.Thread{ThreadID: id, Height: ui.HeightFill}}}}}
```

A pane draws no border or background; put a `card` section inside it (or it inside one)
for a visible box. `height`:

| `height` | The pane is | A fill box? |
|---|---|---|
| `"auto"` (default) | as tall as its nodes, at least `minHeight` | no |
| pixels (120..1600) | that tall; `minHeight` must not be more | yes |
| `"fill"` | the rest of its own box below its top, at least `minHeight` (default 240) | yes |

Nodes taller than a px or fill pane scroll inside it; `noScroll: true` cuts them instead
(use it when the pane's one node scrolls itself, a thread or a terminal, so there is no
second scrollbar). `minHeight` is 0 or 120..1600.

## grid

```json
{"key": "cards", "grid": {"minWidth": 200, "items": [
  {"key": "c-build", "children": [{"key": "c-build-card", "section": {"card": true, "title": "Build", "children": []}}]},
  {"key": "c-deploy", "span": 2, "children": [{"key": "c-deploy-card", "section": {"card": true, "title": "Deploy", "children": []}}]}]}}
```

```go
cards := ui.NewGrid("cards",
	ui.NewGridItem("c-build", buildCard),
	ui.NewGridItem("c-deploy", deployCard).WithSpan(2),
)
cards.Grid.MinWidth = 200 // 0: 240
```

- **Columns** = `max(1, floor((width + 12) / (minWidth + 12)))`, at most 6, from the
  node's own measured width; `minWidth` is 160..480 px (absent = 240). At 240: 2 columns
  from 492 px, 3 from 744; the panel at its default width is always 1. The columns are
  equal (`1fr` each) and 12 px apart, rows too; the count does not shrink to the items, so
  two items in a wide grid keep a card's width.
- **1 to 24 items.** An item has a `key` (it counts as an element), `children`, and a
  `span` (1 or 2, absent = 1), never more than the columns there are. Items fill rows in
  order (no packing). An item's only node stretches to its row's height, so a row of
  `card` sections lines up; with several nodes, they keep their heights.
- **One column** (the side panel): the items stack in order, spaced like the list around
  the grid (12 px at the top level, 6 px in a section). Put the most important card first.
- A grid is a container (it counts toward the 4), its items are not levels.

## divider and spacer

```json
{"key": "rule", "divider": {}}
{"key": "rule-checks", "divider": {"label": "Checks"}}
{"key": "gap", "spacer": {"size": 24}}
{"key": "push", "spacer": {"flex": true}}
```

```go
ui.NewDivider("rule", "")              // a hairline
ui.NewDivider("rule-checks", "Checks") // hairlines either side of a centred small-caps label
ui.NewSpacer("gap", 24)                // 0: 12
ui.NewFlexSpacer("push")
```

- A **divider** is a 1 px rule across the list; with a `label` (one line, at most 200
  characters, cut when longer than the width) the label sits centred between two rules.
  Use it between groups of nodes that need no section title.
- A **spacer** adds `size` px (4..64, absent = 12) to the list's gap between its
  neighbours (at the top level 12 + 12 = 24 px by default).
- `flex: true` grows to the free height of its **box**, so the nodes after it sit at the
  box's bottom: an actions bar under a short list. The box is a pane with a px or fill
  height, or the surface's body itself, and only when the spacer is in that box's own list
  (not inside a section, column, grid item or auto pane in it). Anywhere else, and when the
  box has no free height (its nodes already fill it), the spacer is its `size`.

## group

```json
{"key": "line", "group": {"align": "between", "items": [
  {"key": "line-text", "text": {"content": "3 of 4 checks passed"}},
  {"key": "line-bar", "actions": {"buttons": [{"key": "rerun", "label": "Re-run", "action": {"event": "rerun"}}]}}]}}
```

```go
line := ui.NewGroup("line", ui.AlignBetween, summaryText, ui.NewActions("line-bar", rerun))
line.Group.NoWrap = true // the default wraps
```

- Holds **text, chips, actions and progress** nodes only (1 to 8 of them); any other kind
  is refused (blocks such as markdown or lists, containers, dividers and spacers, groups).
- Items sit on one line, 8 px apart and centred vertically, each as wide as its content;
  a progress bar takes the free width (at least 160 px). They wrap onto more lines when
  they do not fit, unless `noWrap: true` (then they shrink and wrap inside themselves).
- `align`: `start` (default), `center`, `end` or `between` (the free space between them).
  An actions bar's own `align` takes only `start` or `end`.
- A group is not a container: its items sit at its depth. They count as elements.

## What "fill" fills

A thread, terminal or pane with `height: "fill"` takes the height of its **box** below
its own top:

- its box is the nearest enclosing pane with a px or fill height; an auto pane, a
  section and a column are not boxes (fill looks past them);
- with no such pane, the box is the surface's scrolling body (the panel), less its 16 px
  bottom padding;
- a fill thread or terminal is never under 240 px, a fill pane never under its
  `minHeight` (240 px when unset): when its box has less room, the box scrolls;
- two fill nodes in one box do not share it: the first takes the rest, the second is
  pushed below. Give one of them a px height.

So `pane(fill) > thread(fill)` makes a thread the height of the panel below it;
`pane(600) > [text, thread(fill)]` makes the thread 600 px minus the text; `pane(fill) >
pane(fill)` makes the inner one the rest of the outer; inside columns side by side, a
fill node in one column reaches the bottom of its box and the row (and every column)
grows to match.

## Limits

- 2..4 columns; weight 1..6; width 160..640 px; pane height 120..1600 px or auto or fill;
  minHeight 0 or 120..1600 px.
- Grid: 1..24 items, minWidth 160..480 px, at most 6 columns, span 1..2. Group: 1..8
  items. Spacer: size 4..64 px. Divider label: 200 characters.
- A node sits inside at most 4 containers (section, columns, pane, grid, in any mix):
  `section > columns > pane > section > node` is the deepest. A column is part of its
  columns node and a grid item of its grid, not a level; a group is no level.
- Columns, grid items and group items count as elements toward the view's 400.
- Thread and terminal nodes inside panes and columns are live streams like any others: the
  app keeps at most 2 live at once across plugin views (`primitives.md`, thread and
  terminal), so a layout with three threads shows the third paused with Attach.

## Patterns

- **Log beside facts**: `columns[ col(weight 2: pane(320: log, list)), col(markdown, pairs) ]`:
  side by side on a page, the pane over the facts in the panel.
- **Summary, then detail on a page**: `columns(collapse first)[ col(summary), col(weight 2:
  pane(fill, noScroll: thread(fill))) ]`: the panel shows the summary only.
- **A list that must not push the actions off screen**: `pane(400: list)` then the actions
  bar after it.
- **Cards**: `grid[ item(section card), item(span 2: section card), ... ]`: one column in
  the panel, a dashboard on a page.
- **A status line**: `group(between)[ text, actions ]` instead of a text and an actions
  bar on two lines.
- **Actions at the bottom of a box**: `pane(fill)[ list, spacer(flex), actions ]`.
