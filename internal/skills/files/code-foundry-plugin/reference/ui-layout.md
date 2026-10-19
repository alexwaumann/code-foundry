# Layout: columns and panes

Two container nodes arrange other nodes: **columns** (side by side) and **pane** (a box
with its own height and scroll). A surface shows in the side panel (about 360 px wide,
the user can widen it) and, later, in pages of the main pane: one view serves both, so
every columns node says how it degrades to one column. Check
`h.HasCapability("view.node.columns")` (`view.node.pane`) before sending them: an older
host refuses the view.

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
- A node sits inside at most 4 containers (section, columns, pane, in any mix):
  `section > columns > pane > section > node` is the deepest. A column is part of its
  columns node, not a level.
- Columns count as elements toward the view's 400.
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
