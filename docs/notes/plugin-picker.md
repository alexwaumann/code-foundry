# Plugin picker: a select the plugin searches

A plugin can now offer a searchable select (people, issues, labels): the options come from the
plugin as the user types. Modelled on the app's reviewer picker (`components/pr/ReviewerPicker.tsx`,
`reviewerSearch.ts`) and on `Input.Live`'s one-act-in-flight sender (`form.ts liveSender`).

## Shape

- **On `Select`, not a new node.** `Select.Search *Search` turns a dropdown into a picker. Values,
  drafts, `change`, required, form submit, the toolbar's form rules and `plugintest.Pick` all carry
  over from the select; a parallel node would have duplicated each. `Select.Options` stay what the
  picker lists before typing; `Search.Results` are the answer to `Search.Query`.
- **Two lists, not one.** With a single list the before-typing state would depend on the plugin
  resetting it, and a picked value's label could vanish with the next search. Options (recent, a
  "Selected" group) stay put; results come and go.
- **Own key for the search act.** Every acting element is addressed by a key, one per key. The
  field's key already belongs to its `change` act, so `Search.Key` is the search act's
  (`PickerField` makes it the field's key + `-search`). A CLI client can act on it by key or by
  event (`plugin act --action search-people --value ale`); Validate refuses a search event equal
  to the field's change event so the event alone stays unambiguous.
- **Rich options are a picker's only.** `group`, `detail`, `avatar`, `icon` on an option of a
  plain select are refused rather than ignored. A picker's option has a `detail`, not a
  `description`.
- **Avatar colour from the value.** The plugin sends one or two initials; the host hashes the
  option's value to one of `--cf-chart-1..6`, so one person keeps one colour across views. The
  chart slots moved from "pages only" to live in `docs/THEMES.md` (`liveSlots.test.ts`).

## The search act and stale answers

- From 2 characters (trimmed, counted in code points as the daemon counts), after 250 ms without
  typing, the GUI sends a `search` act (`pluginsdk.ActSearch`: Key, Action = event, Field, Value =
  query, the form's Values). `searchSender` wraps `liveSender`: one act in flight, the newest last,
  the same term twice running once; going under 2 characters drops what waits; closing the picker
  cancels it.
- **Telling a stale view apart: the plugin echoes the query.** `WithResults(act.Query(), …)` puts
  it in `Search.Query`. The GUI shows results only when that equals the term in its box; otherwise
  "Searching…". So an answer to "al" arriving after the user typed "ale" is never shown (no
  prefix reuse: the reviewer picker does the same). A refused search shows "Search failed" (the
  act's error is toasted too).
- The daemon trims the query and refuses it under 2 or over 200 characters; `searchElement`
  and `searchQuery` live in `internal/store/plugin/surface_search.go`.

## Picking

- A pick is the select's `change` (multi: the whole list, `value` comma-joined, `values[name]`
  the list). A single picker closes on a pick and picking the chosen value again clears it unless
  `required`; a multiple one stays open, shows tokens (× and Backspace on an empty box), and stops
  at `MaxPicked` (20): unpicked rows go disabled.
- Labels for picked values: current results, then options, then what this picker saw when the
  user picked (a value picked from an older search), then the value itself. The skill asks
  plugins to keep picked values among the options (a "Selected" group) so a reload names them.
- Keyboard is cmdk's (arrows, Enter) and Radix's (Esc closes, focus back on the trigger, also
  after a single pick: Radix moves it a task later, which the vitest test waits for).

## Toolbar

- No new strip kind: a picker is a dropdown select, already allowed in a toolbar form. In a strip
  the trigger is compact: the label (muted) then the picked labels, `max-w-64`, no free width.
- `stripItemClass` gives a form of only pickers (no submit, no secondary buttons) `min-w-0`
  instead of `flex-1`, so "Filter runs  [Branch main ▾]  chips" does not split the row between two
  growing forms. A form mixing a picker and an input still grows.

## Degrading to the 360 px panel

- Body: the trigger is full width; the popover takes the trigger's width (as the multi-dropdown
  does) and Radix flips it above when there is no room below.
- Toolbar: the compact trigger wraps to its own line like any strip item; its popover is 288 px
  and kept inside the panel (`usePanelBoundary`, `POPUP_FIT`), checked in the e2e test.
- A long detail truncates first (at most 40 % of the row), then the label (tooltip when cut).

## Tests

- Go: `pluginsdk/ui/picker_test.go` (validation table, builders, strip, element limits), the
  fuzz seed `pickerSeed`, `internal/store/plugin/surface_search_test.go` (the act end to end,
  query bounds, element listing), `pluginsdk/plugintest/picker_test.go` (`Search`, `Results`,
  `Pick`), `plugins/examples/hello/picker_test.go` (the demo's pickers).
- vitest: `picker.test.ts` (threshold, debounce, one in flight, stale dropping, grouping, tones,
  toggling, labels) and `PickerControl.test.tsx` (what it lists, acts sent, tokens, Backspace,
  Enter, Esc, focus, limit, compact trigger, strip width).
- e2e `plugin-picker.spec.ts`: one flow through the mock (popover inside the panel, the search
  reaching the mock plugin and its answer coming back, a pick filtering the runs) plus the
  SHOTS-gated screenshots.

## Demo and mock

The hello demo's Layout toolbar has a Branch picker (icons) that filters the runs; its Form tab
has a Reviewers picker (avatars, details, a disabled bot) in the settings form. The captured
fixtures gained the two fields; `gui/frontend/mock/pluginPickers.ts` renders them as
`plugins/examples/hello/picker.go` does, and the mock's act passes the act's value through.

## Gotchas

- cmdk sets `data-value` on its items from the `value` prop (the option's key here), so rows
  carry the option's value in `data-option`.
- Option keys share the view's key namespace: an option in both Options and Results needs two
  keys (`rec-ada`, `match-ada`).
- The skill's verb checker reads any backticked `a.b` as a CLI verb: write "the search's
  `query`", not `search.query`.
