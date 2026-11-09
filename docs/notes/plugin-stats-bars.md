# Plugin stats and bars

Two display nodes for a plugin's numbers, drawn like the app's own Pull Requests page: `stats`
(the five count cards) and `bars` (the Merged PRs / Commits chart cards, as bars).

| What | Where |
|---|---|
| SDK: `Stats`/`StatCard`, `Bars`/`Bar`/`BarsReference`, limits, builders, validation | `pluginsdk/ui/charts.go` (+ the `Node` fields and kind checks in `ui.go`, `validate.go`) |
| Host: capabilities `view.node.stats`, `view.node.bars`; `[]` cards and bars; a card's or bar's action is an element (its command held to the permissions) | `internal/store/plugin/surface_act.go` |
| Shared look, out of the PRs page: `FigureCard`, `ChartCard`, `ChartTooltip` (+ `tooltip.ts`) | `gui/frontend/src/components/charts/` |
| Renderers and their pure decisions | `components/plugin/nodes/StatsNode.tsx`, `BarsNode.tsx`, `components/plugin/charts.ts` |
| Hello demo: Overview's stats row (Failing toggles the chart to failed builds) and build-time chart (a bar's click toasts) | `plugins/examples/hello/charts.go`; fixture `hello-demo/overview.json`; mock `patchFailedOnly` |
| Skill | `reference/nodes.md` (stats, bars), `primitives.md` (index, click acts), limits table in `internal/skills/plugin.go` |

## Decisions

- **Stats values are strings** the plugin formats ("86%", "4m 12s"): the host never guesses
  units. 1 to 6 cards, label 40 characters, value 24 and one line.
- **Tones** are the existing `Tone`: `ok` emerald, `attention` amber (the PRs page's warn),
  `error` red, `muted`. Emerald now also shows on stat figures and bars (the package doc and the
  skill say so); text elsewhere still reads `ok` as neutral.
- **A card with an action is a toggle**; `pressed` without an action is refused. While one card
  is pressed the other toggles dim, exactly as the PRs filter cards (shared `FigureCard`).
- **Layout** (`statsColumns`): all cards in one row when each gets 100 px, else the fewest
  balanced rows (4 → 2×2, 5 → 3+2), never shrinking a card. Measured with the node's own
  ResizeObserver, like the grid; the column count must balance rows, which CSS alone cannot.
- **Figure role** (`figureRole`): one role for the row, the largest whose estimated width of the
  widest value fits a card. Display (`text-display-sm`) only when the node is at least 560 px
  wide (an expanded panel or a page: the row is then the page's headline figures, as on the PRs
  page); title in the side panel; heading when even that does not fit, then "…" as a last
  resort. The width estimate uses per-class advances measured in WebKit ("4m 12s": 3.15 em at
  title, 3.37 at display) plus 8 % headroom. One measurement decides both columns and role, so
  the unit tests pin them (jsdom has no container queries).
- **Bars** are coloured by `status` (the status tokens; running is a faint fill with a dashed
  outline, so a bar still growing reads apart; pending/skipped/off muted) or by `series` 1..5,
  the PRs/Usage charts' palette (`SLOT_COLORS`), not both. No theme chart slots: those are
  pages-only today and duplicate the status colours.
- **Scale**: the top is the highest bar or the reference value; a zero (or an all-zero chart)
  draws a 2 px stub so it can still be pointed at. Bars share the width in slots, gap a fifth of
  a slot (none below 3 px slots, so 120 bars in the panel stay visible), at most 40 px wide.
- **One tooltip** (shared `ChartTooltip`): beside the highlighted bar on the side with more room,
  `fit` so it never passes the plot's edge (the middle bars of a 386 px panel have ~180 px). The
  other bars dim to 40 %. Its title line has the status glyph (or the series swatch).
- **Keyboard**: the plot is one tab stop (`role=group`); focus highlights the newest bar,
  ←/→ move (stopping at the ends), Home/End jump, Enter/Space act. A polite live region reads the
  highlighted bar's title and meta. Up/Down are left to the page's scroll.
- Neither node goes in a toolbar, footer or group (`StripKinds`, `groupKinds` unchanged).

## How it degrades at panel width

The side panel's body is 386 px at its default width. Stats: three cards stay in a row
(title figures), four go two by two; a figure never wraps. Bars: width-fluid, 30 bars are
~11 px, 120 are ~3 px with no gap; header subtitle is cut first (whole text on hover), the
reference label keeps its place. Expanded, the same view shows one row of display figures and
40 px-capped bars.

## Tests

- Go: `pluginsdk/ui/charts_test.go` (every validation branch, body-only, elements, builders and
  JSON), fuzz seed `chartsSeed` and the property generator; host `charts_internal_test.go` and
  the `every` view; `plugins/examples/hello/charts_test.go` (figures agree, toggle, bar act).
- Vitest: `charts.test.ts` (columns, figure role, tones, geometry, heights, paint, opacity, keys,
  tooltip placement), `statsbars.test.tsx` (layout by width, tones, toggles, inert, tooltip on
  pointer, dimming, click and Enter acts, live region, empty chart, the demo fixture).
- E2E `plugin-stats-bars.spec.ts`: real figure widths fit at panel and expanded widths, the
  tooltip stays inside the panel for edge and middle bars, the toggle through the mock.
  `SHOTS=<dir>` saves the PR's screenshots.

## Gotchas

- The PRs `SummaryCards` and `ActivityCharts` now render through the shared pieces; their tests
  pass unchanged. `prs/activity.ts` re-exports `tooltipSide` from `components/charts/tooltip.ts`.
- `TestEveryKindIsOneKind` pins the kind count (now 25); other node builders landing first
  change it too, so it conflicts on rebase by design.
- The overview fixture was spliced from the real plugin's output (`HELLO_DUMP_OVERVIEW=<file>`
  in `charts_test.go`), keeping the captured header, ids and time so the mock's patches apply.
