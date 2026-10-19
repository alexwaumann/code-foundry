# Layout: columns, panes, grids, inline nodes, containers, master-detail, node tabs, toolbar and footer

Container nodes arrange other nodes: **columns** (side by side), **pane** (a box with its
own height and scroll), **grid** (cards in as many columns as fit), **container** (a
capped, centred width), **masterDetail** (a list beside its chosen row's detail) and
**tabs** (a node's own tab strip). **divider**, **spacer** and **group** (leaves on one line) space
and line up nodes without a container. Two view slots pin nodes around the scrolling
body: the **toolbar** and the **footer**. A surface shows in the side panel (about 360 px
wide, the user can widen it) and, later, in pages of the main pane: one view serves both,
so every container says how it degrades to one column. Check
`h.HasCapability("view.node.columns")` (`view.node.pane`, `view.node.grid`,
`view.node.divider`, `view.node.spacer`, `view.node.group`, `view.node.container`,
`view.node.masterDetail`, `view.node.tabs`, `view.toolbar`, `view.footer`) before
sending them: an older host refuses the view.

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
second scrollbar). `minHeight` is 0 or 120..1600. A log that is a sized pane's only node
shrinks to the pane (down to 4 lines), so its newest lines stay in view; beside other
nodes it keeps its `rows` and the pane scrolls, so give it rows that fit.

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
  they do not fit, unless `noWrap: true` (then they shrink and wrap inside themselves, a
  progress bar below its 160 px too).
- `align`: `start` (default), `center`, `end` or `between` (the free space between them).
  An actions bar's own `align` takes only `start` or `end`.
- A group is not a container: its items sit at its depth. They count as elements.

## container

```json
{"key": "page", "container": {"width": "narrow", "children": [{"key": "intro", "markdown": {"source": "…"}}]}}
```

```go
page := ui.NewContainer("page", ui.ContainerNarrow, introNode, formNode) // ui.ContainerWide, ui.ContainerFull
```

`width`: `narrow` is at most 680 px, `wide` at most 1080 px, both centred; `full` (the
default) has no cap. The side panel is narrower than either, so there every container is
full width; on a page (or a widened panel) a narrow container keeps text and forms at
reading width and a wide one is the page's main column. It draws nothing and spaces its
nodes like the list around it. It is a container for the depth limit; fill looks past it.

## masterDetail

```json
{"key": "runs", "masterDetail": {"selected": "run-5", "listWidth": 280,
  "list": {"rows": [{"key": "run-6", "title": "Build #6", "glyph": {"status": "running"}},
                    {"key": "run-5", "title": "Build #5", "glyph": {"status": "failed"}}]},
  "emptyDetail": {"glyph": {"icon": "list"}, "title": "No run chosen"},
  "detail": [{"key": "run-facts", "pairs": {"items": []}}]}}
```

```go
md := ui.NewMasterDetail("runs", ui.List{Rows: rows}, selected, detailNodes...) // selected: "" or a row key
md.MasterDetail.EmptyDetail = &ui.Empty{Title: "No run chosen"}
```

- **Wide** (the node's own width at least `listWidth` + 12 + 320 px: **612 px** by
  default) the list sits on the left at `listWidth` (200..400, absent = 280) and the detail
  fills the rest, 12 px apart, each scrolling on its own (at its end the wheel scrolls
  the body on, so what follows the node stays reachable). The node is as tall as the
  taller side and never taller than the rest of its box below its top (a pane with a px
  or fill height, else the surface's body; at least 240 px), so a long list scrolls
  beside a short detail.
- **Narrow** (always the side panel at its default width) it shows the **list alone**.
  Choosing a row shows the **detail alone**, under a back button with the row's title;
  Back shows the list again (nothing is sent). The host keeps "showing the detail" per
  node and view tab, and shows the list again when `selected` changes to something that is
  not a row (`""` included) or when `resetToken` changes: send a new token to bring the
  user back to the list (after deleting the run, say).
- **Choosing a row** without an `action` sends a `select` act, which the plugin answers
  with a view whose `selected` is that row and whose `detail` is its detail (like a tab):

  ```json
  {"kind": "select", "action": "select", "key": "run-5", "value": "run-5", "node": "runs"}
  ```

  A row with an event action sends its click instead (the plugin still answers with the
  new `selected`); a command, URL or copy row runs it and is not chosen. The host shows
  the last row chosen as selected (the old detail dims) from the click until a view
  selects it (views reach the GUI up to 100 ms after the act's answer), at most 5 s after
  the answer; a view that selects another row then, or none that selects it, sends the
  panel back to the list. It goes back to `selected` at once if the act fails (return an
  error to refuse).
- `selected` is `""` or a row's key (anything else is refused). `emptyDetail` (an `empty`
  node's fields) is the detail side while nothing is selected, when wide. Rows count as
  elements and share the view's keys; row buttons work as in a `list`.
- Refused because the app would not show them: a row's own `selected` (the node's
  `selected` decides), and `detail` nodes while `selected` is `""` (send them with the
  row that shows them). The `select` act carries no `values`.
- The detail holds any nodes within the depth limit (the master-detail is a container).
  Form drafts and collapsed sections in it are kept per selected row. The hidden side is not drawn, so a thread
  or terminal in the detail holds no stream while the panel shows the list.

## tabs (a node's own)

```json
{"key": "run-tabs", "tabs": {"active": "run-tab-log",
  "items": [{"key": "run-tab-overview", "label": "Overview"}, {"key": "run-tab-log", "label": "Log", "badge": {"label": "1 error", "tone": "error"}}],
  "children": [{"key": "run-log-pane", "pane": {"height": 240, "children": [{"key": "run-log", "log": {"text": "…"}}]}}]}}
```

```go
tabs := ui.NewTabsNode("run-tabs", ui.NewTabs(active, ui.NewTab("run-tab-overview", "Overview"), ui.NewTab("run-tab-log", "Log")), children...)
```

- A tab strip for one part of the view (a section's, a pane's, a column's, a detail's),
  drawn like the view's tabs one step smaller, scrolling with its list (not pinned);
  `children` are the active tab's nodes. **2 to 8 tabs**; `active` must be one of them;
  tab keys share the view's keys (a view tab `log` and a node tab `log` collide).
- Switching sends the view's `tab` act with the tabs node's key in `node` (`""` for the
  view's own tabs; dispatch on it):

  ```json
  {"kind": "tab", "action": "tab", "key": "run-tab-log", "value": "run-tab-log", "node": "run-tabs"}
  ```

  The plugin answers with a view whose `active` is that tab and whose `children` are its
  nodes; the last tab clicked reads as active until a view shows it (at most 5 s after
  the answer, as for a master-detail's row). Form drafts and collapsed sections are kept
  per node tab, as per view tab. It is a container. A label wider than 16rem is cut,
  with the whole label in a tooltip.
- **Nested tabs or sections?** Tabs when the parts are alternatives the user looks at one
  at a time (a run's overview or its log); sections (collapsible if long) when they are
  read together or compared. Prefer the view's own tabs for whole pages.

## toolbar and footer

```json
{"header": {"title": "Runs"},
 "toolbar": [
   {"key": "search", "form": {"fields": [{"key": "search-q", "name": "q", "label": "Filter runs", "input": {"placeholder": "Filter runs"}}],
     "submit": {"key": "search-go", "label": "Filter", "icon": "search", "iconOnly": true, "action": {"event": "filter"}}}},
   {"key": "status", "chips": {"chips": [{"key": "st-all", "label": "All", "selected": true, "action": {"event": "status", "data": "all"}},
     {"key": "st-failed", "label": "Failed", "status": "failed", "action": {"event": "status", "data": "failed"}}]}}],
 "nodes": [],
 "footer": [
   {"key": "count", "text": {"content": "2 of 6 runs", "size": "sm"}},
   {"key": "bar", "actions": {"align": "end", "buttons": [{"key": "rerun", "label": "Run again", "style": "attention", "action": {"event": "rerun"}}]}}]}
```

```go
submit := ui.EventButton("search-go", "Filter", "filter").WithIcon("search").AsIconOnly()
search := ui.NewForm("search", &submit, ui.TextField("search-q", "q", "Filter runs").WithPlaceholder("Filter runs").WithValue(query))
v := ui.View{Header: h, Toolbar: []ui.Node{search, statusChips}, Nodes: body,
	Footer: []ui.Node{countText, ui.Node{Key: "bar", Actions: &ui.Actions{Align: ui.AlignEnd, Buttons: buttons}}}}
```

- The **toolbar** sits under the header and the plugin's tabs, the **footer** at the
  bottom of the surface; the body scrolls between them and never under them. Each has a
  hairline toward the body and the panel's padding.
- **Up to 6 nodes each**, of these kinds only: `text`, `chips`, `actions`, `progress`,
  `form` whose fields are inputs, toggles and dropdown selects (no fieldsets, no
  `"style": "list"` selects), `divider` without a label (a vertical hairline between
  neighbours in the row), `spacer` (`size` px across; `flex: true` pushes what follows to
  the row's end: it takes the free width when nothing else in the row grows, and next to
  none beside a form, a progress bar or a group not aligned to the start, which keep it)
  and `group`. Anything else is refused
  (`toolbar[1]: a list node cannot be in the toolbar (…)`). Their nodes and elements count
  toward the view's 400 and share its keys.
- **One row that wraps**: a form and a progress bar take the free width, an end-aligned
  actions bar goes to the row's end, text and chips are as wide as their content; what
  does not fit moves to the next line (in the panel, a search field and four chips are two
  lines). In a strip a form's text inputs and selects show no label or description (the
  label names the control for screen readers: give a `placeholder`), a toggle shows its
  label beside it; errors show under the control and the form's own error under the row.
  Drafts, Enter to submit, Escape, `busy` and `resetToken` work as in the body.
- **Per view tab**: the toolbar and footer are part of the view the plugin sends for the
  active tab, like `nodes`. The host keeps nothing of them across tabs: a tab whose view
  has none shows none, and a toolbar that belongs on every tab is sent with every tab's
  view (its form drafts are still kept per tab).
- Keep them short: the footer for a count and the actions on the whole view, the toolbar
  for search and filters. Content that grows belongs in the body.

## What "fill" fills

A thread, terminal or pane with `height: "fill"` takes the height of its **box** below
its own top:

- its box is the nearest enclosing pane with a px or fill height; an auto pane, a
  section and a column are not boxes (fill looks past them);
- with no such pane, the box is the surface's scrolling body (the panel between the
  toolbar and the footer, or the header and the panel's bottom), less its 16 px bottom
  padding, so a fill node ends 16 px above the footer;
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
  minHeight 0 or 120..1600 px; container width narrow (680 px), wide (1080 px) or full.
- Grid: 1..24 items, minWidth 160..480 px, at most 6 columns, span 1..2. Group: 1..8
  items. Spacer: size 4..64 px. Divider label: 200 characters. Toolbar and footer: 6
  nodes each. Master-detail: listWidth 200..400 px (280), the detail at least 320 px
  beside it. A tabs node: 2..8 tabs.
- A node sits inside at most 4 containers (section, columns, pane, grid, container,
  masterDetail, tabs, in any mix): `section > columns > pane > section > node` is the deepest. A column is part
  of its columns node and a grid item of its grid, not a level; a group is no level.
- Columns, grid items, group items and the toolbar's and footer's nodes count as
  elements toward the view's 400.
- Thread and terminal nodes inside panes and columns are live streams like any others: the
  app keeps at most 2 live at once across plugin views (`primitives.md`, thread and
  terminal), so a layout with three threads shows the third paused with Attach. The app's
  other streams (a terminal in the bottom panel, a second panel) can leave fewer live: a
  node then says it is waiting for a connection, and Attach is not offered meanwhile.

## Patterns

- **Log beside facts**: `columns[ col(weight 2: pane(320: log, list)), col(markdown, pairs) ]`:
  side by side on a page, the pane over the facts in the panel.
- **Summary, then detail on a page**: `columns(collapse first)[ col(summary), col(weight 2:
  pane(fill, noScroll: thread(fill))) ]`: the panel shows the summary only.
- **A list that must not push the actions off screen**: the actions bar in the `footer`
  (or `pane(400: list)` then the bar after it).
- **Cards**: `grid[ item(section card), item(span 2: section card), ... ]`: one column in
  the panel, a dashboard on a page.
- **A status line**: `group(between)[ text, actions ]` instead of a text and an actions
  bar on two lines.
- **Actions at the bottom of a box**: `pane(fill)[ list, spacer(flex), actions ]`.
- **Search and filter a list**: `toolbar[ form(input q, submit icon-only), chips(status) ]`
  over the list in the body, the count in the `footer`.
- **A page's reading column**: `container(narrow)[ markdown, form ]`; the panel shows it
  full width.
- **A list/detail page**: `masterDetail(list of items, detail: pairs, tabs[Overview: markdown,
  form | Log: pane(240: log)])`: two sides on a page, the list then the item in the panel.
  Keep filters in the `toolbar` above it and the row's actions in the detail.
