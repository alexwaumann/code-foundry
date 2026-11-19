# Placement by kind

A user asked that a tab open where tabs of the same kind already are: a pull request with the
other pull requests, a diff with the diffs. Before this, placement never looked at kind. A linked
surface went beside its thread's other linked tabs of any kind (rules 2 to 6), and a tab of no
thread went to the focused pane. The spec is `docs/notes/shell-model.md`, "Linked surfaces".

## The rule

With smart placement on (`layout.smart_placement`, i.e. `Options.NoSmartPlacement` unset), a
surface other than a thread's own tab or a composer, when nothing chose a pane, lands:

1. already open: focused where it is (unchanged);
2. **rule `kind`**: in a pane holding a tab of the same kind for this thread, right after the last
   of them;
3. **rule `kind-any`**: for any kind but a terminal, in a pane holding a tab of the same kind for
   any thread or for no thread, at the end of its strip;
4. otherwise the old rules, unchanged: 2 to 6 for a linked tab whose thread's tab is in the space,
   the focused pane (`hostPane`) for the rest.

With the setting off, placement is exactly what it was before. A pane the caller chose ("+", a
drop, `--pane`) still wins. A tab of no thread and a tab whose thread has no tab in the space get
the new rules too. Rule `kind` cannot apply to a tab of no thread.

The code is `kindHost` in `internal/layout/place.go`, called from `place` before the old
branches. Every op that places through `place` gets it: `open_surface`, a remembered tab put back
fresh by `open_thread`, the linked tabs `move_thread` and `move_pane` carry, `reopen_closed` when
the old pane is gone, and `new_thread`/`open_draft` (a composer, which `kindHost` leaves to
`threadHost`).

## Decisions (beyond what was agreed)

- **Ranking.** Both new rules use `rank` without sides. A pane that also holds a linked tab of this
  thread comes first, then the nearest by centre distance, then layout order. Distance is measured
  from the thread's pane, or from the focused pane when the tab has no thread or its thread's tab
  is not in the space. Rules 3 and 4 rank the same way, so "a pane that already holds a tab of
  this thread wins" holds everywhere (`open_surface-kind-mine-first`).
- **Where in the strip.** Rule `kind` goes right after this thread's last tab of that kind, as
  agreed (`open_surface-kind-thread-after-last` shows it landing mid-strip). Rule `kind-any` goes
  at the end of the strip, as rules 3 and 4 do. Going after the last tab of the kind would split
  another thread's run of tabs, and rule 2 relies on a thread's tabs sitting together.
- **Collapsed panes** are no candidate for either rule, as `threadHost` and `recentTaker` skip
  them. The old rules 3 and 4 still accept a collapsed pane; that is unchanged.
- **`canTake`** is checked on every candidate, but it cannot refuse one today. A pane holding a
  non-terminal tab is never terminals-only, so it is never raised. A terminal joining terminals
  does not raise a pane either. The check stays so the rule does not depend on that.
- **Terminals.** Rule `kind` applies: a thread's new terminal joins that thread's terminals. Rule
  `kind-any` skips terminals, so a terminal never joins another thread's terminals by kind.
  Rules 3 and 4 may still put it in a pane of another thread's linked tabs, as before. A terminal of
  no thread (a project's shell, a worktree's action run) gets neither rule and still goes to the
  focused pane.
- **Rule names** are `kind` and `kind-any`. Their phrases in `internal/command` are "beside the
  thread's other tabs of its kind" and "with the open tabs of its kind". An item verb for a
  thread whose tab is not open used to say the tab opened "in pane P, the focused pane of its
  space". Placed by kind, it now says "in pane P, with the open tabs of its kind".
- **Old fixtures.** The eight `open_surface-rule2-*`, `rule3-*` and `rule4-*` cases now run with
  `no_smart_placement`. They pin the old rules, which are also the fallback with the setting on.
  `open_surface-kind-skips-collapsed` and `open_surface-kind-terminal-not-any` pin that fallback
  with the setting on.
- **Not changed:** the item verbs' descriptions still say "beside a thread". That is still where
  a tab goes when no tab of its kind is open, and each result's message names the rule that
  actually placed it.

## Where exact kind is the wrong grouping

"Same kind" is the exact kind string. Where that is wrong or debatable:

- **Plugin surfaces**: `plugin.<plugin>.<surface>` is one kind per surface, so two surfaces of the
  same plugin do not attract each other (`open_surface-kind-exact`). If a plugin ships a family of
  surfaces meant to sit together, matching by plugin would be better. No plugin needs that today.
- **File tabs** hold code files, HTML pages (`view.open.page`, `view.inline --panel`) and images
  alike, so a thread's HTML page joins another thread's source files.
- **Diff and file** are separate kinds, so a file never joins diffs, although both are "code".
  Kept apart on purpose: the request was "same kind".
- **Pages** (`prs`, `projects`) are one per space, so rule 1 always catches them first. `mcp` is
  one per thread, so another thread's MCP tab draws a new one. `ember.board` is one per space.

## Tests

- Go fixtures `internal/layout/testdata/ops/open_surface-kind-*.json` (12): rule `kind` mid-strip
  and for a terminal; rule `kind-any` beating this thread's pane, for a tab of no thread and for a
  thread not open; nearest, mine first, collapsed skipped; a terminal not joining another
  thread's terminals; exact kind; and the setting off for a linked tab and for a tab of no thread.
  Each case's result was written by hand first; `-update` then wrote only `want`.
- `TestSmartPlacement` gains two rows, each run with the setting on and off: a pull request of no
  thread, and another thread's terminal.
- The property test's no-resize check covers `kind` and `kind-any`; both fire in its run (9 and 5
  times when counted, out of 400 sequences).
- Commands: `TestViewOpenIdentity` now expects rule `kind` for a second tab of the same kind;
  `TestViewOpenForAThreadWhoseTabIsNotOpen` gains the message for a tab placed by kind.
- Mock (`gui/frontend/mock/layout.ts`): `kindHost` and a shared `nearest` (rank without sides) are
  ported. The fixtures whose result is `kind`, `kind-any` or `focused` run against it, and those
  that fall back to rules 2 to 6 are skipped as before. A `MockLayout` test runs a diff of no
  thread with the setting on and off.

## End to end

A dev daemon on a scratch `CODE_FOUNDRY_HOME`, driven through `LayoutService.Apply` (curl,
Connect JSON), with `code-foundry layout show` and `code-foundry settings set
layout.smart_placement` from the CLI:

- The Pull Requests page focused, a pull request of no thread in the pane beside it: a second
  pull request of no thread went to that pane, `kind-any`. With the setting off, a third went to
  the focused page's pane, `focused`.
- Thread A's tab in one pane, A's diff below it, thread B's pull request in a third pane: a pull
  request for A went to B's pane, `kind-any`. With the setting off it went beside A's diff, rule
  2. A terminal for A, with no terminal open, fell back to rule 2.

## Gotchas

- The setting's description (`internal/store/settings/schema.go` and the mock's `settings.ts`)
  covers the new rules, since the same setting turns them off.
- `place` now nils the thread's pane when it is in another space before `kindHost` runs, so "no
  thread pane here" is one check (`tp == nil`) for the old branch too.
