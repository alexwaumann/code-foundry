# Plugin table meter cells

A plugin author wanted "a bar for its share of the total" in a table and drew it with
`▰▱` characters in a mono cell. A table cell can now be a **meter**: a thin track with a
fill and an optional short label after it, in the one cell. The design was picked from a
sketch; this records it as built.

```
SUITE          PASS RATE
unit           ████████████  100%
integration    ██████████░░   86%
e2e            █████░░░░░░░   41%
lint           ░░░░░░░░░░░░    –
```

| What | Where |
|---|---|
| SDK: `Meter{Value, Label, Tone}` on `Cell`, `MeterCell`, `Cell.WithMeterTone`, `MaxMeterLabel`, `TableMeterCapability`, the checker | `pluginsdk/ui/table_meter.go` (+ the `Cell` field and its JSON in `table.go`) |
| `plugintest`: `Host.TableCell(instance, table, row, column)`; the capability in `HostCapabilities` | `pluginsdk/plugintest/table.go`, `table_meter.go` |
| Host: `view.table.meter` announced; validation is the SDK's | `internal/store/plugin/table_meter.go` |
| GUI: `TableMeter` type, `cellParts` returns `meter`, `columnWidths`; the pure decisions; the cell | `src/api/pluginTable.ts`, `components/plugin/table.ts`, `meter.ts`, `nodes/MeterCell.tsx`, `nodes/TableNode.tsx` |
| Hello demo: "Suites in #1285" on the Runs tab, between Builds and Tests | `plugins/examples/hello/builds.go`; fixture `hello-demo/run-list.json` |
| Skill | `reference/nodes.md` (table section); the label limit in the limits table (`internal/skills/plugin.go`) |

## Decisions

- **What the plugin sends**: `{"meter": {"value": 0.86, "label": "86%", "tone": "attention"}}`.
  `value` is a fraction, 0 to 1; `label` is the plugin's own text ("52%", "3 of 8", "–"):
  the host never formats a number or guesses units, as with the stat cards. A cell with only
  a value still encodes as its Inline; a meter cell is always the object form. `value` has no
  `omitempty`, so 0 is sent; `{"meter": {"label": "–"}}` decodes as value 0 and is valid.
- **Validation** (SDK `Validate`, which the daemon runs): `value` finite and in [0, 1]. NaN,
  ±Inf and out-of-range values are refused, never clamped ("86 is outside 0..1 (a fraction:
  0.86 for 86%)"). `label` is at most 16 characters (`MaxMeterLabel`) and one line. `tone` is
  an existing `Tone` ("neutral" included, as elsewhere). A meter is the cell's whole content:
  a value, glyph or pill beside it is refused.
- **Track**: 6 px (`h-1.5`), `rounded-full`, `bg-cf-text/10`. It takes the cell's remaining
  width (`flex-1`).
- **Fill**: `rounded-full`, width `value × 100%`. Neutral is `bg-cf-text/55`. The tones use
  the stats' and bars' status colours: `ok` `bg-cf-success` (emerald), `attention`
  `bg-cf-warning`, `error` `bg-cf-error`, `muted` `bg-cf-text-muted`. An unknown tone from a
  newer plugin draws neutral. A value of 0 draws the empty track. Any value above 0 has
  `min-width: 2px`. The track's `overflow-hidden` keeps a sliver inside its rounded ends.
  In the light theme `muted` reads a little darker than neutral, because the muted token is
  solid and neutral is the text colour at 55 %. That is the agreed mapping; it was left as
  it is.
- **Label**: after the track, in a fixed 40 px slot (`w-10`), right-aligned, `text-caption`
  (muted) with tabular figures. Every row has the same slot, so a column's tracks line up.
  A label longer than the slot is cut, and `Tip whenTruncated` shows it whole.
- **Accessibility**: `role="meter"`, `aria-valuenow` (the value as a whole percentage,
  0..100), `aria-valuemin` 0, `aria-valuemax` 100, and `aria-valuetext` = the label when
  there is one. The value text stays when the label is hidden.
- **Table behaviour is unchanged**: column widths, priorities and dropping, sorting (still the
  plugin's), row actions and menus. A meter column a plugin ranks low drops like any other.

## The label threshold (measured)

WebKit, caption role (13 px), tabular figures, measured in the e2e browser:

| Label | Width |
|---|---|
| "100%" | 36.3 px |
| "86%" | 28.2 px |
| "3 of 8", "1 of 5" | 35.6 px |
| "–" | 7.5 px |
| "12 of 345" | 60.0 px (cut in the slot; whole in the tooltip) |

- The slot is 40 px: the widest short label (36.3 px) and a little room.
- The track keeps at least 48 px beside a label. Shorter, it is barely longer than the label
  beside it and a percent is under half a pixel.
- So the label shows when the cell is at least **96 px** wide (48 + the 8 px gap + 40).
  Below that, the label goes, the track takes the whole cell, and the track's tooltip shows
  the whole label (allowed: the text is hidden).
- The cell's width is not measured per row. `columnWidths` (pure, in `table.ts`) works it out
  from the box width the table already measures. It resolves the grid template as CSS does
  for `minmax(Npx, Wfr)`:
  - fixed tracks take their width;
  - the 20 px inset, the 12 px gaps and the buttons' and ⋯ tracks come off;
  - the rest is shared by weight;
  - a column whose share is under its floor is frozen at the floor, and the rest is shared
    again.
- The e2e test checks the real cell widths against the same numbers.
- In the demo, Suite is weight 2 (floor 96) and Pass rate weight 1 (floor 64):
  - side panel at 420 px: a 386 px box, so Pass rate is 117 px and the labels show;
  - narrowest panel at 280 px: a 246 px box, so Pass rate is 71 px and the labels go.

## Capability and how it degrades

- The host announces `view.table.meter` (`ui.TableMeterCapability`), as `view.list.rows` is
  announced, in its own file. A plugin checks `h.HasCapability("view.table.meter")` and sends
  `ui.TextCell(label)` without it. The hello demo does this, and `plugintest` tests both ways.
- **The degrade rule for unknown cell content**: the daemon decodes a view into the SDK's
  types and re-encodes it, so unknown fields are dropped. On an older daemon,
  `{"meter": …}` has neither `text` nor `spans`, so it decodes as the cell form, loses the
  unknown field and becomes `{}`: an empty cell, with no refusal. The GUI's `cellParts` also
  reads an object with none of the known keys as empty.

## Tests

- Go:
  - `pluginsdk/ui/table_meter_test.go`: every refusal (NaN, ±Inf, under 0, over 1, a percent
    instead of a fraction, a long label, two lines, a return, an unknown tone, beside a
    value, a glyph or a pill), the JSON round trip (0 kept), and the builders.
  - The fuzz seed (`tableSeed`) has a meter column.
  - Both copies of the view generator make meters, and broken ones: out of range, or beside a
    value.
  - `plugintest/table_meter_test.go`: `TableCell`, and an older host's text fallback.
  - `internal/store/plugin/table_meter_internal_test.go`: the host's acceptance with the
    canonical form, its refusals, and the capability.
  - The hello demo's `builds_test.go` checks the suites' cells and the text fallback, and
    that the fixture matches.
- Vitest:
  - `meter.test.ts`: the fill, the percentage, the threshold and the tone classes.
  - `table.test.ts`: `columnWidths` (unknown before measuring, fixed and weighted, frozen
    floors, the buttons' and ⋯ tracks, floors that do not fit), `cellParts` with meters, and
    the demo's suites table at 384 and 244 px.
  - `metercell.test.tsx`: role and values, fill width and tone class, the 2 px least fill,
    labels in the side panel, the label gone and the tooltip at 246 px, no label, and a meter
    as the cell's whole content.
- WebKit, `e2e/plugin-table-meter.spec.ts`. It checks only what needs a browser:
  - the real cell, track, fill and label geometry at the panel's width (tracks lined up,
    labels uncut in their slot);
  - the narrowest panel (no labels, the tracks the whole cell, under 96 px);
  - `SHOTS` screenshots, dark and light.
- Real app (scratch `CODE_FOUNDRY_HOME`, `make gui-build`, hello linked with `plugin dev`,
  a no-project thread, the Runs tab through `plugin act --key run-list`):
  - `plugin surface hello demo --shot` at `--width 420` showed the labels beside the tracks;
  - at `--width 280` the labels were gone and the tracks stayed;
  - both in the dark theme and, after `settings.set appearance.theme light`, the light one.

## Gotchas

- A stubbed `ResizeObserver` that calls its callbacks with no entries breaks once a Radix
  tooltip is open: floating-ui's observer destructures its entries. `metercell.test.tsx`
  passes `[]`.
- The Runs tab now has five nodes. `runs_test.go` pins the count.
- After this merges the SDK needs a new tag. It adds API (`Meter`, `MeterCell`,
  `WithMeterTone`, `MaxMeterLabel`, `TableMeterCapability`, `plugintest.Host.TableCell`),
  so it should be `pluginsdk/v0.6.0` (the last tag is `v0.5.1`).
- A daemon restart is needed for this build: the capability and view validation are the
  daemon's.
