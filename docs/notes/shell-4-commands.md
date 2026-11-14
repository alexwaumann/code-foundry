# Shell PR 4: space, pane, tab and thread.open commands

Fourth PR of the shell stack (`docs/notes/shell-plan.md`, section 4). Every layout action is now
a command in `internal/command`, so the CLI and a thread's model can read and arrange the layout
the window will show, and `LayoutService` runs every op of `internal/layout`. No default chords:
the old panels still own the keys; the cutover PR maps them. The classic window is unchanged: it
ignores the layout, and no existing verb changed behaviour.

## What is in it

| Where | Holds |
| --- | --- |
| `internal/command/commands_layout.go` | `RegisterLayout`, the shared rules (explicit ids from a thread, focus), the id kinds, `layout.show`, `space.list`, `tab.list` |
| `commands_space.go`, `commands_pane.go`, `commands_tab.go`, `commands_thread_open.go`, `commands_composer_drafts.go` | the verbs below |
| `internal/command/resolve.go` | id kinds `TabID` (`t-`), `PaneID` (`p-`), `SplitID` (`s-`), `SpaceID` (id, suffix or name), `DraftID` (`d-`) |
| `internal/command/all`, `internal/daemon/daemon.go` | `Deps.Layout`, wired to the layout store |
| `internal/guide/layout.go` | the `layout` topic's conventions (`code-foundry guide layout`) |
| `internal/layout/area.go` | `WithArea`: the pane area for an op that lays panes out |
| `internal/layout/keep_focus.go` | `Options.KeepFocus`: run any op without moving the user's focus |
| `internal/layout/neighbour.go` | `Layout.Neighbour`: the pane a direction key goes to |
| `internal/layout/ops_tree.go` | `close_pane` closes its thread tabs as threads |
| `proto/codefoundry/v1/layout.proto` | cases for PR 2's and PR 2b's ops, the wider response, a space's drafts |
| `internal/api/layout_ops_thread.go`, `layout_ops_drafts.go` | their converters; the converter test is strict again |

## The verbs

All are in the category (and guide topic) `Layout`. "Default" is what the user's call acts on
when the id is left out; from inside a thread that id is required.

| Verb | Does | Default | Classified |
| --- | --- | --- | --- |
| `layout.show [--space]` | the outline: spaces, splits with sizes, panes, tabs (`*` active), focused pane, thread names; `--json` the whole layout and the viewport | all spaces | read-only, no palette, no chord |
| `space.list` | spaces in order, current marked, panes and tabs | | read-only, no palette, no chord |
| `tab.list [--space] [--thread]` | tabs in layout order with space, pane, kind, thread | | read-only, no palette, no chord |
| `space.new [--name] [--focus]` | a new space after the others | | |
| `space.rename <name> [--space]` | rename | current space | no chord |
| `space.remove [<space>] [--to <space> \| --archive]` | drops its tabs and panes; its threads move (`--to`, default the space on its left) or are archived; asks first when it has tabs or threads | current space | confirm |
| `space.switch [<space>] [--index n] [--focus]` | show another space (by id, suffix, name or place from 1) | | no chord, focus only |
| `space.move <space> --index n` | reorder the top bar | | no palette, no chord, no index |
| `pane.focus --pane <p> [--focus]` | focus a pane | | no palette, no chord, no index, focus only |
| `pane.focus.left/.down/.up/.right [--pane] [--to] [--focus]` | focus the neighbour on that side | focused pane | no index, focus only |
| `pane.move.left/.down/.up/.right [--pane] [--to]` | swap with the neighbour on that side | focused pane | no index |
| `pane.move <pane> (--beside <p> --edge e \| --into <p> [--index n] \| --outer e \| --space <sp>) [--frac] [--focus]` | move a whole pane | | no palette, no chord |
| `pane.split [--pane] [--tab] [--edge right] [--frac] [--focus]` | split a tab off into a new pane on an edge | focused pane, its active tab | no index |
| `pane.close [<pane>]` | close a pane; its threads close as threads | focused pane | |
| `pane.resize --split <s> --sizes 0.6,0.4` | a split's shares | | no palette, no chord |
| `tab.focus <tab> [--focus]` | focus a tab | | no palette, no chord |
| `tab.move <tab> (--pane <p> [--index n] \| --split <p> --edge e \| --outer e \| --space <sp>) [--frac] [--focus]` | move a tab | | no palette, no chord |
| `tab.close [<tab>]` | close a tab; a thread's tab is `thread.close` | focused tab | |
| `tab.next`, `tab.previous [--pane] [--focus]` | round the pane's strip | focused pane | no index |
| `thread.open <id> [--pane] [--focus]` | open (or focus) a thread's tab; its remembered set comes back | | no palette, no chord |
| `thread.close [<id>]` | close a thread's tab from its space, remembering its linked tabs | active thread | |
| `thread.space.move [<id>] --space <space>` | move a thread with its linked tabs | active thread | no chord |
| `composer.new [--space] [--pane] [--project] [--workspace] [--like] [--focus]` | New thread in the shell (`new_thread`) | | no palette, no index |
| `composer.draft.start --tab <t> [--id] [--label]` | the empty composer becomes a draft | | no palette, no chord, no index |
| `composer.draft.label <draft> <label>`, `.clear <draft>`, `.discard <draft>`, `.open <draft> [--focus]` | the composer's and the sidebar row's draft ops | | no palette, no chord, no index |

Every verb is `PageState`. "No index" means the agents' command index leaves it out
(`index_test.go` says why).

## Decisions

- **Commands call the store, not the service.** The PR 3 note asked for it: commands take
  `layout.Store` (`layouttest.Fake` in tests), as the memory and skill commands take theirs.
  `LayoutService` stays the GUI's door; both reach the same ops.
- **The pane area.** An op that lays panes out (placement, restore, remembering where a closed tab
  sat, `close_pane`, moving a thread) gets the store's viewport when it names no area of its own:
  `core.WithArea`, called by the store's `Apply` (and the fake's), so the API, the commands and
  later the daemon glue all measure the same way. The viewport is the last size any window
  reported while this daemon runs, kept when that window goes; before any report (the CLI with
  no window open, or after a restart) it is 1180 x 820. It is not stored: a size remembered from
  another display would be as wrong as the default, the layout is proportional, and only rule 5's
  "room" and the direction verbs read pixels. `layout.show` prints the size it lays out in.
- **Explicit ids from a thread.** A call that is not the user's in person (`Context.FromUser`
  false: a thread's CLI, a page, a plugin) gets no default from the user's focus: leaving out the
  tab, pane, space or thread is an `invalid argument` naming the flag and pointing at
  `layout show`. The app and the user's own CLI default to the stored focus (the current space,
  its focused pane, that pane's active tab) and, for thread verbs, to the active thread.
- **Focus from a thread** is `core.Options.KeepFocus` (new): the op runs, then the current space,
  each space's focused tab (or its pane, when the tab went) and MRU are put back. A tab the op
  opened or moved stays active in its own pane and waits behind the focused tab in the focused
  pane: plan 2.6's rule, now for every op, not only those with a `focus` flag. Smart swap does not
  run, as the focus did not change. `--focus` turns it off. `space.switch`, `pane.focus` and
  `pane.focus.<dir>` would do nothing under it, so from a thread they are refused without
  `--focus`; `tab.focus` is not: under it, it makes the tab active in its pane.
- **`close_pane` closes threads as threads** (the PR 1 and PR 2 notes asked for it): each thread
  tab in the pane closes as `close_thread`, remembering its linked tabs wherever they are, then
  what is left of the pane goes. Changed in the op itself, not in the command, so the commit is
  one; the plain close of a thread's tab is no use to anyone. The earlier cases did not change.
- **Direction verbs** use `Layout.Neighbour` on the plain `Rects` in the viewport: of the panes
  touching that side, the one focused most recently (first to hold a tab of the space's MRU),
  else the longest shared edge. The GUI's presenter resolves the neighbour from what it draws
  (rails, minimums) and passes `--to`; the CLI leaves it out. `pane.move.<dir>` is `swap_pane`.
  A key with no neighbour does nothing and says so on the CLI only.
- **`pane.split`** is "split a tab off into a new pane" (`move_tab` with an edge of its own pane);
  a pane of one tab is refused (`failed precondition`): there is nothing to split off.
- **`space.remove`** asks (Confirm) when the space has tabs or threads, and says what happens:
  "Remove space "Review"? Its tab closes, and its thread moves to "Main"." Archiving lists the
  user's own threads (`created_by user`, not archived) that live in the space and archives each
  through `ThreadService.Archive` before the op; their children go with them by the cascade. Its
  unlinked terminals are not ended here (see "For later PRs").
- **Spaces by name.** `SpaceID` resolves an id, a unique suffix, or a name (any case), so
  `space switch Review` works. Tabs, panes, splits and drafts take ids or unique suffixes.
- **Thread verbs live in the `Layout` category**, so `code-foundry guide layout` has every verb a
  model arranges the window with; the `thread` topic stays about driving threads.
- **The guide budget.** The index's new lines put the guide 23 bytes over its 11000-byte budget;
  `pane.focus` (focus only) and `space.move` (the top bar's drag) left the index rather than the
  budget rising. The topic's conventions say how to act without the user's focus.
- **Drafts (PR 2b, merged before this one).** Its six ops have proto cases and converters, a
  space carries its drafts in `LayoutSpace.drafts`, and `ApplyLayoutResponse.draft_id` reports
  the draft an op started, opened or ended. Its note asked for verbs: `composer.new` is the
  shell's New thread (`new_thread`), and the five `composer.draft.*` verbs are the composer's and
  the sidebar row's. `thread.new` keeps its meaning until the shell is the window, so the classic
  window's New thread is unchanged; none of these is in the palette or the agents' index.
- **Proto changes** (nothing released): `OpenThreadOp.compose_tab_id`, `OpenSurfaceOp.space_id`,
  `ArchiveThreadOp`, `SnoozeThreadOp`, the six draft ops, and the response's `rule`, `kept`,
  `ended`, `back_tab_ids`, `placed_tab_ids`, `fresh_tab_ids`, `swapped_pane_ids`, `draft_id`. The
  converter test checks every case and every op of `core.OpNames()` again (the lead's `pending`
  stopgap on `shell` is gone).

## Verification

- `make check` green.
- Command tests over `layouttest` (`commands_layout_test.go`): refusals from inside a thread for
  each verb with a focus default; focus-only verbs refused without `--focus` and run with it; a
  thread's moves keep the user's focus (into the focused pane, elsewhere, a thread opened in
  another space) and `--focus` takes it; the user's keys (`tab.next`/`previous` round the strip,
  `pane.focus.right` by geometry, nothing to the right, `pane.move.left`, `pane.split`); closing a
  thread's tab and a pane with a thread remember its diff, reopening brings it back; the argument
  shapes of plan 2.8 (`tab.move` four ways and its mistakes, `pane.move` four ways, `pane.resize`
  by a split suffix); spaces (new from the user and from a thread, rename, switch by index and by
  name, reorder, remove with the question, `--to`, `--archive`, an empty space without a
  question, the last space); `layout.show`'s outline and JSON; suffixes and names; drafts end to
  end; no store.
- Core: three new JSON cases (`close_pane-closes-threads`, `move_tab-keep-focus`,
  `focus_tab-keep-focus`); `TestNeighbour`; `TestWithArea`; the property run draws `KeepFocus`
  at random. Store: `TestApplyMeasuresInTheViewport`, `TestApplyKeepFocus`. API:
  `TestLayoutThreadOps` (composer replaced, rule 6 at 600px and rule 5 at 1600px from the
  reported viewport, close and restore, move, snooze, archive), `TestLayoutDraftOps`.
- Classification lists: `palette_test.go`, `index_test.go`, `keybindings_test.go`,
  `readonly_test.go`, `page_class_test.go`, `commands_test.go`. Guide: the `layout` topic.

### End to end with the built binary

`make build`, a daemon on `CODE_FOUNDRY_HOME=$(mktemp -d /tmp/cf4.XXXX)` (removed afterwards; a
short path, as the socket's must be). The second `thread open` is a typo of the id, kept: a
suffix that names nothing is refused.

```
$ code-foundry thread new --no-project --name Shell e2e one
created thread Shell e2e one (s-4aee935c5628) in /Users/alex (no project)
[exit 0]
$ code-foundry thread new --no-project --name Shell e2e two
created thread Shell e2e two (s-d914214d7fe2) in /Users/alex (no project)
[exit 0]
$ code-foundry thread open 5628
opened thread s-4aee935c5628 as tab t-e7jxxpuj in pane p-zgsvpgwj of space sp-yfico7nf
[exit 0]
$ code-foundry thread open 14fe2
code-foundry thread.open: no thread id ends in "14fe2"
Run `code-foundry help thread.open` for usage.
[exit 2]
$ code-foundry layout show
rev 1, laid out in 1180x820
space sp-yfico7nf "Main" (current) (default: threads with no space live here)
  pane p-zgsvpgwj (focused)
    * t-e7jxxpuj thread s-4aee935c5628 "Shell e2e one"
[exit 0]
$ code-foundry tab list
t-e7jxxpuj  sp-yfico7nf  p-zgsvpgwj  thread s-4aee935c5628
[exit 0]
$ code-foundry thread open d7fe2
opened thread s-d914214d7fe2 as tab t-s3sigaao in pane p-zgsvpgwj of space sp-yfico7nf
[exit 0]
$ code-foundry layout show
rev 2, laid out in 1180x820
space sp-yfico7nf "Main" (current) (default: threads with no space live here)
  pane p-zgsvpgwj (focused)
      t-e7jxxpuj thread s-4aee935c5628 "Shell e2e one"
    * t-s3sigaao thread s-d914214d7fe2 "Shell e2e two"
[exit 0]
$ code-foundry tab move sigaao --split zgsvpgwj --edge right
moved tab t-s3sigaao to pane p-knoa6kzm in space sp-yfico7nf
[exit 0]
$ code-foundry layout show
rev 3, laid out in 1180x820
space sp-yfico7nf "Main" (current) (default: threads with no space live here)
  row s-4jdn3czq [0.50 0.50]
    pane p-zgsvpgwj
      * t-e7jxxpuj thread s-4aee935c5628 "Shell e2e one"
    pane p-knoa6kzm (focused)
      * t-s3sigaao thread s-d914214d7fe2 "Shell e2e two"
[exit 0]
$ code-foundry pane resize --split 4jdn3czq --sizes 0.65,0.35
resized split s-4jdn3czq
[exit 0]
$ code-foundry pane focus left
focused pane p-zgsvpgwj
[exit 0]
$ code-foundry space new --name Review
new space sp-6jblahjk "Review"
[exit 0]
$ code-foundry thread space move d7fe2 --space review
thread s-d914214d7fe2 is in space sp-6jblahjk "Review"
[exit 0]
$ code-foundry layout show
rev 7, laid out in 1180x820
space sp-yfico7nf "Main" (default: threads with no space live here)
  pane p-zgsvpgwj (focused)
    * t-e7jxxpuj thread s-4aee935c5628 "Shell e2e one"
space sp-6jblahjk "Review" (current)
  pane p-fmwt3wwq (focused)
    * t-s3sigaao thread s-d914214d7fe2 "Shell e2e two"
[exit 0]
$ code-foundry space list
  1. sp-yfico7nf  Main  1 pane, 1 tab
* 2. sp-6jblahjk  Review  1 pane, 1 tab
[exit 0]
# as the thread s-4aee935c5628 (CODE_FOUNDRY_THREAD set):
$ code-foundry tab close
code-foundry tab.close: from inside a thread, name the tab (--tab): the user's focused tab is not yours to act on; `code-foundry layout show` lists the ids
Run `code-foundry help tab.close` for usage.
[exit 2]
$ code-foundry space switch Main
code-foundry space.switch: space.switch only moves the user's focus; from inside a thread pass --focus, and only when the user asked to be taken there
Run `code-foundry help space.switch` for usage.
[exit 2]
$ code-foundry thread open d7fe2
thread s-d914214d7fe2 is open as tab t-s3sigaao in pane p-fmwt3wwq of space sp-6jblahjk (nothing changed)
[exit 0]
$ code-foundry layout show
rev 7, laid out in 1180x820
space sp-yfico7nf "Main" (default: threads with no space live here)
  pane p-zgsvpgwj (focused)
    * t-e7jxxpuj thread s-4aee935c5628 "Shell e2e one"
space sp-6jblahjk "Review" (current)
  pane p-fmwt3wwq (focused)
    * t-s3sigaao thread s-d914214d7fe2 "Shell e2e two"
[exit 0]
# daemon restarted (kill 88156, new daemon pid 90165)
$ code-foundry layout show
rev 7, laid out in 1180x820
space sp-yfico7nf "Main" (default: threads with no space live here)
  pane p-zgsvpgwj (focused)
    * t-e7jxxpuj thread s-4aee935c5628 "Shell e2e one"
space sp-6jblahjk "Review" (current)
  pane p-fmwt3wwq (focused)
    * t-s3sigaao thread s-d914214d7fe2 "Shell e2e two"
[exit 0]
$ code-foundry space remove Review
code-foundry space.remove: Remove space "Review"? Its tab closes, and its thread moves to "Main".
Re-run with --yes to confirm.
[exit 2]
$ code-foundry space remove Review --yes
removed space sp-6jblahjk "Review"; 1 thread moved to "Main"
[exit 0]
$ code-foundry layout show
rev 8, laid out in 1180x820
space sp-yfico7nf "Main" (current) (default: threads with no space live here)
  pane p-zgsvpgwj (focused)
    * t-e7jxxpuj thread s-4aee935c5628 "Shell e2e one"
[exit 0]
```

## Gotchas

- `plural` already exists in the package (`commands_update.go`) with one form; the layout verbs
  use it rather than a second one.
- Rewriting a classification list by script flattens its hand grouping (`readonly_test.go` groups
  by domain): add a line instead.
- `noIndex` is compared to the sorted registry without sorting itself; keep it sorted.

## For later PRs

- **PR 6 (glue)**: the verbs report what they closed (`Result.closed`, `kept`, `ended`) but end no
  terminal: `tab.close` and `pane.close` on an unlinked terminal tab, `space.remove` (whose tabs
  all close) and the thread ops' `ended` need the glue that ends them. `space.remove --archive`
  archives through the thread store, whose events reach the layout through that glue.
- **PR 7 (`view.open.*`)**: `thread.focus` becomes `thread.open --focus`; `thread.open` already
  takes `--focus` and opens with no window (the layout shows it when one opens).
- **PR 10/11 (GUI)**: the window reports `SetViewport`; its focus-in handler runs
  `pane.focus --pane`; direction keys pass `--to` from the rendered frame; `tab.close` and
  `pane.close` are `cmd+w` and `cmd+shift+w`; the nine space chords invoke
  `space.switch --index n`. The space's drafts are in `LayoutSpace.drafts`.
- **Cutover (PR 20)**: the chords of the spec's key table go into `Command.Keybindings` on these
  verbs; `composer.new` takes `cmd+n` (or `thread.new` runs it from the app).
- **Viewport per window**: the store keeps the last report from any window; preferring a visible
  one needs presence (PR 3 note).
- **`tab.rename`, `tab.auto-name`, `pane.fullscreen`, `terminal.*` and `view.open.*`** are later
  PRs' (plan 2.8, 2.10).
