# Plugin tables

The plugin UI's Table node, from the approved sketches (Jenkins at panel width and
expanded, Jira grouped). Rows of short facts under column headers. It is drawn like the
app's own Pull Requests tables. Columns drop by importance as the table narrows; the
plugin sorts, and the host only asks.

## SDK (`pluginsdk/ui/table.go`)

- `Table{Title, Count *int, Columns, Rows | Groups, Sort, Dense, EmptyText}`.
  - Rows or groups, not both.
  - 1 to `MaxTableColumns` (10) columns.
  - `MaxTableRows` (300) rows, all groups' together.
  - `MaxTableGroups` (20) groups.
- `TableColumn{Key, Label, Align, Weight | Width, MinWidth, Priority, Style, Sortable, SortFirst}`.
  - Column keys share the view's namespace and count as elements.
  - A row's `Cells` map is keyed by column key, so a cell of no column is refused.
  - `Width` (16..480 px) fixes a column.
  - Otherwise `Weight` (1..6) shares the free width, never under `MinWidth` (16..480, 0 is 80).
    Width and weight are exclusive, and `MinWidth` goes only with a weight.
  - `Label` may be "" (an icon column), at most 40 characters, one line.
  - `Align` is start or end.
  - `Style` is `muted`, `mono` (the `text-code` role) or `caption`.
  - `Priority` is 0..9. `SortFirst` is only for a sortable column.
- `TableRow{Key, Cells, Action, Actions (≤ 3), Menu, Selected}`: a list row's acting
  parts, with cells for a title. Menu buttons are refused on a row (`Row.Menu` instead), as
  in a list.
- `Cell{Value *Inline, Glyph, Pill}` encodes as the bare Inline when only `Value` is set.
  It decodes from a string, `{text, spans}` or `{value, glyph, pill}`; an object with
  neither `text` nor `spans` is the cell form (so `{}` is an empty cell).
- `TableGroup{Key, Label (≤ 60), Count *int, Collapsed, Rows}`: `Count` is shown instead of
  the row count when set.
- `TableSort{Column, Dir}` must name a sortable column, with asc or desc.
- Builders:
  - `NewTable`, `NewGroupedTable`, `TableCol` (`NewColumn` was taken by the columns node).
  - `WithWidth`, `WithWeight`, `WithPriority`, `AlignEnd`, `WithStyle`, `AsSortable`.
  - `NewTableRow`, `WithAction`, `WithMenu`, `WithButtons`, `AsSelected`.
  - `NewTableGroup`, `AsCollapsed`, `WithCount`.
  - `TextCell`, `InlineCell`, `StatusCell`, `PillCell`, `Cell.WithGlyph/WithPill`.
  - `NextSort`, `Table.AllRows`.
- Elements: the node, columns, groups, rows, a row's buttons and menu items. Cells are not.
- Sort acts (`pluginsdk/table_acts.go`): `ActSort` ("sort"). `Key` is the column, `Node`
  the table, `Value` "asc" or "desc", read with `act.Descending()`.
- Capability `view.node.table`.
- `plugintest`:
  - `Host.Sort(ctx, inst, column, dir)`. `dir` "" asks what a click asks.
  - `Host.TableRows(inst, table)`.
  - `PickItem` now finds table rows' menu items.
- Fuzz: `tableSeed` in `FuzzView`, and a `table` kind in both view generators.
- The generators: the daemon's copy of `viewgen_test.go` was behind (no stats, bars, date
  input or ANSI log). It is the SDK's copy again, with the package line and its header
  comment kept.
- The property test's path resolver now takes a map key that holds dots or any text, such
  as a cells entry keyed by a column "x.y". Its element count adds tables.

## Daemon (`internal/store/plugin/surface_table.go`)

- A sortable column is an acting element: kind `sort`, the table as its node. It records
  the direction a click without a value asks for in that version (`ui.NextSort`).
- `Act` takes the client's "asc" or "desc", or that default; any other value is
  `InvalidArgument`. Like a tab or a select, it drops form values.
- Finding by action name skips sorts, as it skips tabs and selects.
- Table rows index like list rows: an action (labelled by the first cell's text in
  `SurfaceElements`), buttons and menu items.
- `fillLists` makes a table's columns and each group's rows `[]`.
- The surf test panel has a table, `ptable`. `table_acts_test.go` covers first and next
  directions, the client's value, a bad value, unsortable columns, the table itself, and
  the element list.
- Two old tests used `"table"` as the example of an unknown node kind. They now use
  `"calendar"`.

## GUI

- `components/table/` is extracted from `components/prs`. The PRs page uses it, and its
  tests pass unchanged:
  - `fit.ts`: `fitColumns`, the longest prefix of a ranking whose floors and 12 px gaps fit,
    with at least `keep`. The PRs page converts its rem floors at 16 px.
  - `TableParts.tsx`: the box, the body, the row and grid classes, and `TableHead`,
    `RowGrid`, `SectionTitle` (moved from `PrBits`, with a `captionTestId`) and
    `GroupLabel`. `GroupLabel` gains a collapsible form: a button with a chevron and
    aria-expanded. Without a toggle it is the PRs label as before.
- `components/plugin/table.ts` (pure):
  - `rankColumns`: priority descending, then display order.
  - `columnFloor`, `columnTrack`: `Npx`, or `minmax(Npx,Wfr)`.
  - `tableLayout(data, width)`.
  - `nextSort`, `cellParts`, `tableItems`: group labels and rows, collapsed groups' rows left
    out.
- The fold:
  - Rows' buttons get one shared track, as wide as the widest row's (`menu.ts buttonsWidth`).
  - They fold into the rows' ⋯ menus unless every column fits beside them, so the buttons
    go before any column. All rows fold together, unlike a list's per-row fold: a column
    must be one width.
  - A dense table always folds labelled buttons, as a dense list does.
  - A 24 px ⋯ track is reserved when a row has a menu or its buttons folded.
- `nodes/TableNode.tsx`:
  - It measures its box (`useElementWidth`, minus the 2 px border) and draws the shown
    columns only: a dropped column's cells are not in the DOM.
  - Header cells are grid cells (`data-col`). A sortable one holds a button (`Sort by X`,
    or `X, sorted descending`) with the arrow on the label's inner side.
  - The arrow asked for shows while the plugin's view still has the sort it had at the
    click. A refused act clears it at once, an answered one after `CHOICE_HOLD_MS`.
  - Rows reuse #621's parts as they are: `rowMenuItems`, `MoreMenu` (hidden until hover or
    focus, its place kept), `RowContextMenu` and `openRowMenuFromKey`.
  - Cells are `InlineLine`, so a cut cell gets `Tip whenTruncated`, after a glyph (drawn as
    an icon) and before a pill. Every cell has tabular figures.
  - Group collapse uses the sections' store (`setCollapsed`, `draftKeyOf(instance, viewTab,
    group)`), read with one `useShallow` selector. It outlives re-renders and is kept per
    view tab.
  - The body is a `VirtualStack` (lazy over 40 lines, against the panel's scroll).
- The sort act goes out through `actOnElement` with `action: "sort"` and the direction.

## Hello demo, fixtures, mock

- The demo is at its 8-tab limit (`MaxTabs`), so the tables sit on the **Runs** tab, under
  its master-detail (`builds.go`):
  - **Builds (1288)**: the 30 demo builds.
    - `#` (a status glyph, fixed, priority 9, sortable, descending first) and `Status` (a
      pill).
    - `Branch` (mono, sortable) and `Cause` (an error tone on failures).
    - `Started by` (muted), `Duration` (end, mono, sortable) and `Age` (caption).
    - Each row has a menu (Rebuild, Open console | Open in CI, Copy link | Abort on the
      running one) and opens a toast on click.
    - The failed builds have a Rerun button.
  - **Tests in #1285**: dense, grouped into Failed 2, Flaky 1 and Passed 142, with Passed
    collapsed and 8 rows sent.
- Widths were tuned so the side panel's table (386 px box) shows `#`, Branch, Duration and
  Age, as the sketch does: 72 + 84 + 80 + 40 + gaps + ⋯ = 344 px. Duration needs 80 px so
  "DURATION ↓" is not cut.
- `run-list.json` gains the two tables from the real plugin's output
  (`HELLO_DUMP_RUNS=<file>` in `builds_test.go`). `builds_test.go` also checks that the
  fixture matches what the plugin sends.
- Mock (`mock/pluginTable.ts`): it indexes sortable headers and table rows as the daemon
  does. The Runs tab's sort is sorted the way the plugin does it: by cell (durations by ms,
  then text with numeric collation), ties by row key, both in the asked direction. Custom
  views sort too. `mock/pluginTable.test.ts` checks the same orders as the Go test.

## How it degrades at panel width

- Columns drop instead of squeezing, and there is no horizontal scroll.
- The highest-ranked column always shows, even if it then overflows a very narrow box.
- Buttons fold first. In the demo, the panel shows # / Branch / Duration / Age with every
  Rerun in the ⋯.
- The expanded panel shows all seven columns and the Rerun buttons.

## Tests

- Go:
  - `pluginsdk/ui/table_test.go`: every validation branch, elements, the cell JSON, the
    builders' JSON, `NextSort`.
  - `plugintest/table_test.go`.
  - `internal/store/plugin/table_acts_test.go`.
  - The hello demo's `builds_test.go`.
  - The generator, property and fuzz tests.
- Vitest:
  - `table.test.ts`: the drop table by width, prefix and display order, ranking ties,
    tracks, the ⋯ track, the button fold, `nextSort`, `cellParts`, `tableItems`, and the
    demo at 368 px and at 1100 px.
  - `tablenode.test.tsx`: the columns by width (cells not in the DOM), cell parts, the
    heading, empty text, the truncation tooltip, the sort act's key, action and value, the
    asked arrow and its revert, inert, group collapse kept across views and per view tab,
    the row action, the right-click menu with the folded Rerun, the ⋯ with the button
    shown, and no ⋯ without a menu.
- WebKit, `e2e/plugin-table.spec.ts` (real geometry and the stream):
  - At panel width: no row content past the box, and header cells line up with the cells.
  - Expanding brings all columns and Rerun back, still aligned (end columns on their right
    edges).
  - A Duration click comes back sorted from the mock.
  - SHOTS-gated screenshots.

## Gotchas

- `table.test.ts` beside `table.test.tsx` made TypeScript drop one of them from the
  program: `tsc` passed while oxlint's type-aware pass saw only error types. The component
  test is `tablenode.test.tsx`.
- `mock/*.test.ts` that read the fixtures with `readFileSync(new URL(…, import.meta.url))`
  need `// @vitest-environment node`. Under jsdom the URL is not `file:`.
- The sketch drew status pills square-cornered. The table uses the plugin `PillView`
  (rounded-full), as everywhere else in plugin UI.
- A daemon restart is needed for this build: view validation and the act index are the
  daemon's.
