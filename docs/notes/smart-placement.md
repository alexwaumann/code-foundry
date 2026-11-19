# Smart placement for thread tabs

A user asked that a thread they open land beside their other threads rather than in whatever pane
has the focus (a terminal, a diff), in the same family as smart swap. The spec is
`docs/notes/shell-model.md`, "Where a thread's own tab opens".

## The rule

When a thread's own tab or a composer opens and nothing chose a pane:

1. the focused pane, if it has a thread open;
2. otherwise the open pane that has a thread open nearest the focused pane;
3. otherwise the focused pane as before (`hostPane`: a pane of terminals without room gives way
   to the most recently focused pane that can take the tab).

The focus follows the tab. Smart swap still runs after it, in `ApplyWith`, when the tab gains the
focus. The setting `layout.smart_placement` (on by default, Appearance › Panes, after Smart swap)
turns it off, and then only rule 3 applies: today's behaviour exactly.

## Where it lives

| File | Change |
| --- | --- |
| `internal/layout/place.go` | `threadHost` (the rule) and `holdsThread`; `place` sends a composer tab through it |
| `internal/layout/thread.go` | `open_thread`'s default branch uses `threadHost` instead of `hostPane` |
| `internal/layout/op.go` | `Options.NoSmartPlacement`; `tx` carries the options; `Result.Rule` "near" |
| `internal/store/settings` | `layout.smart_placement`, `Settings.Layout.SmartPlacement` |
| `internal/store/layout/store.go`, `internal/daemon/stores.go` | `Options.SmartPlacement`, read at every op, as smart swap's is |
| `internal/command` | "near" phrase for `Result.Rule`; `thread.open`, `composer.new`, `composer.draft.open` descriptions |
| `gui/frontend/mock/layout.ts`, `world.ts`, `settings.ts`, `layoutVerbs.ts` | the same rule (`threadHost`), the mock's setting read at every op, the settings row, the verb descriptions |

No new op and no proto change: smart swap needed neither (the setting reaches the layout as an
op option in the store), and neither does this. The window predicts only focus ops, so it needs
nothing.

## Decisions (the lead's, which the user can overrule)

- **"Has a thread open"** is any tab of the pane, active or not, that is a thread's own tab or a
  composer (empty or a draft). Linked surfaces (diff, pull request, terminal), pages and plugin
  surfaces do not count.
- **"Closest"** is `rank`'s distance between centres from the focused pane, ties in layout order,
  among the open panes that can take the tab (`canTake`); a collapsed pane is skipped, as
  `recentTaker` skips one. Layout order was kept as the tie-break over most recently focused: it is
  what `rank` already does for every other placement rule, and an exact tie in distance is rare
  enough that the more predictable order reads better.
- **Where it applies**: a sidebar click, `thread.open` from the CLI or a link, a new thread's tab,
  New thread (cmd+n, the sidebar's New thread), a draft's row (`open_draft`, also a composer tab
  through `place`), and a reopened thread tab whose pane is gone (`reopen_closed` goes through
  `open_thread`). Not when a pane was chosen: a pane's "+" (`--pane`), a drop (`pane`/`edge`), a
  tab already open (focused where it is), a composer the thread is sent from, the space's lone
  empty composer that a thread replaces.
- **Previews**: a preview opens where a thread's own tab opens (the spec already said "by the same
  rule"), so smart placement chooses its pane too; preview tabs' own rule (taking the space's
  previous preview's place when that is in the chosen pane) is unchanged. With the old preview in
  the pane holding threads and the focus on a pull requests page, the new preview now takes its
  slot instead of closing it and opening in the page's pane
  (`open_thread-smart-placement-preview.json`).
- **Not changed**: moving a thread to another space (`move_thread`: the target space's focused
  pane, by `move_tab`'s `hostPane`) and `add_tab` with a thread tab (no caller sends one without a
  pane) keep the old rule; neither is in "where a thread's own tab opens".

## Tests

- Go fixtures `internal/layout/testdata/ops/*smart-placement*.json`: the focused pane holds a
  thread (behind its active tab), a terminal pane with a thread pane beside it, two candidates at
  different distances (nearest beats more recently focused), a collapsed nearest skipped, no pane
  with a thread, an explicit pane, a composer counting as a thread, a preview, New thread on and
  off. `open_thread-focused-pane` and `open_thread-preview-closes-elsewhere` now run with the
  setting off, since they pin the old rule.
- `TestSmartPlacement` (thread_test.go): a table of states and ops, each run on and off, checking
  the pane, the focus and the rule. `TestSmartPlacementSetting` (store): the setting is read at
  every op. The property test draws `NoSmartPlacement` too.
- Mock: the `new_thread` fixtures run against it (open_thread's are skipped there as "a rule", as
  before); a `MockLayout` test runs open_thread, new_thread, an explicit pane and a page tab with
  the setting on and off. The settings row is the schema's, drawn by the generic settings page, so
  it has no test of its own.

## Gotchas

- `tx` did not carry the options before: smart swap runs after the op, in `ApplyWith`, but this
  runs inside placement, so `tx.opts` was added.
- A pane holding a thread never holds only terminals, so `canTake` on a candidate is always true
  today; the check stays so the rule does not depend on that.
- The mock's open_thread passes a pane to `add_tab` only when smart placement chose another pane,
  so its fallback (a focused pane of terminals without room) is still `add_tab`'s own `hostPane`.

## Later

- The same setting also places other surfaces by kind (a pull request with the pull requests):
  `docs/notes/placement-by-kind.md`.
