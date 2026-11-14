# Shell PR 19: rails and full screen with the floating composer

Nineteenth PR of the shell stack (`docs/notes/shell-plan.md`, section 4). With the shell flag on, a
window too small for every pane at its minimum folds panes to rails, and any pane can be shown full
screen, a linked surface with its thread's composer floating over it. With the flag off nothing
changes.

## What is in it

| Where | Holds |
| --- | --- |
| `components/shell/PaneGrid.tsx` | `shellFrame` (rails) instead of `frameRects`, with the space's focus and MRU and every tab's kind and thread; full screen draws only the focused pane over the whole area |
| `components/shell/PaneView.tsx` | a folded pane is `PaneRail`, an open one `OpenPane` (the old body); the floating composer in a full-screened linked tab |
| `components/shell/PaneRail.tsx` | a rail: the tabs' icons, the selected one marked, attention dots, tooltips, drag sources, and a full screen button |
| `components/shell/PaneTabStrip.tsx` | the full screen button at the strip's right end; in full screen the labelled exit with its key; `AttentionDot`, `TabContentIcon`, `LinkedTip` exported for the rail |
| `components/shell/FloatingComposer.tsx` | the pill, the expanded card with the thread's chip as its drag handle, ⌘L, Escape, collapse after a send |
| `shell/fullscreen.ts` | the rules: which pane shows, enter, leave, toggle, `pane.fullscreen`'s presentation, which Escape leaves, which tab floats a composer, the drag clamp |
| `stores/shellView.ts` | `fullscreen` (the space it is on in) and `floating` (expanded, drag): window state, never stored |
| `shell/keys.ts` | cmd+shift+enter; the pane focus and move keys do nothing in full screen |
| `components/shell/Shell.tsx` | the Escape listener; full screen off when the shell stops drawing |
| `shell/drag/targets.ts`, `drop.ts`, `ShellDnd.tsx` | a rail is one drop target; previews laid out with the grid's own rails; rail tabs named in announcements; in full screen only strip drops |
| `internal/command/commands_pane_fullscreen.go` | `pane.fullscreen [--pane] [--on|--off]`: a ShowView, window state |
| `keys/bindings.ts`, `stores/views.ts` | its presenter (palette) and its ShowView (CLI) |
| `mock/world.ts` | `pane.fullscreen` in the mock's command list |

## Decisions

- **Rails are `rails.ts` as it stands.** The grid hands `shellFrame` the space's focus and MRU and
  the tree with every tab (kind and thread: the minimums go by the active kind, the fold order by
  thread tabs and the focused thread). It lays out again only when one of those changes, not on a
  rename. Nothing about the order was re-decided here.
- **A rail** is 36px (the geometry's), vertical in a row of panes and horizontal in a column. Each
  tab is its icon in a 28px button. **The selected tab** has the strip's active tint, its icon at full
  contrast, and a 2px accent bar on the rail's inner side (left in a vertical rail, bottom in a
  horizontal one): the owner asked for it to be very clear, and the sketch's plain icon was not. The
  attention dot is the strip's (`useAttention`). The tooltip names the tab, a linked one with
  "Diff of <thread>" under it: a rail shows no names at all. A click is `tab.focus` plus a request
  for the keyboard, which unfolds the pane (it is focused now, and a focused pane never folds); the
  newly opened pane takes the keyboard on mount. Its last button shows the pane full screen (the
  sketch has it).
- **A folded pane mounts nothing**: `PaneView` swaps the whole component, so the body, its stream,
  and a thread's quick terminal go with it (PR 13's note).
- **Drops.** A rail is one target as a whole (`zoneAt`: `{kind: "pane"}`), so a tab joins the end of
  its tabs, and the drop's focus unfolds it. Rail tabs are drag sources like strip tabs. The preview
  of an edge or outer drop is laid out with `shellFrame` with the dropped pane focused, so it shows
  the rails the grid will draw after the drop.
- **Full screen follows the space's focus.** The state is the space it was turned on in; the pane
  shown is always that space's focused pane. Since the focus and move keys do nothing while it is
  on, the focus moves only when the user asks for something elsewhere (a sidebar click on a thread
  open in another pane, back and forward, cmd+shift+d placing the diff in another pane), and full
  screen then shows that pane rather than hiding what was asked for. Switching tabs in the pane
  keeps it. Switching space, or a space left with no pane, ends it. The other panes are not mounted
  (plan 2.13). No rails in full screen.
- **`pane.fullscreen`** is a command, window state like `view.thread-info`: from the app its
  presenter toggles at once; from the CLI it is a ShowView every window presents (`--on`, `--off`,
  `--pane`). From inside a thread it needs `--focus`. It is listed in the palette, has no default
  chord in the registry (cmd+shift+enter is in the interim table until the cutover) and is not in the
  agents' index. Category View (a Layout category would have been the only one in the view
  registrations).
- **Leaving.** cmd+shift+enter again, Escape, or the strip's exit control, which in full screen is a
  labelled button "Exit full screen" with an esc key chip at the strip's right end: always visible,
  never a guess. Escape leaves only when nothing before it used the key: a window listener that
  bubbles last, skipping a prevented key, a terminal (a shell's own Escape), a dialog or a menu, and
  a key whose target went away with it (a popover it closed). A list on the page does not keep it:
  the diff's file list takes the keyboard on a click, and Escape there must still leave.
- **The floating composer** is `ThreadComposer`, the thread's real one: its draft (`thread:<id>`
  in the compose store, so the same text in the thread's pane), attachments, model, effort and
  permission, send or steer, Interrupt, and the docked permission and question cards. Collapsed it
  is a pill "Message ● thread ⌘L" at the bottom centre that holds nothing; expanded it holds the
  thread's `WatchThread` (shared with any other view), which the docked asks and the busy state need.
  The thread's chip ("to ● thread", with a collapse button) is centred above the card and is the drag
  handle; the composer's own popovers are portaled and may cover it. Its width is the thread pane's
  composer width (720px), less in a narrow pane. Over a full screen surface its card is opaque and
  lifted (the thread's card is translucent over its own gradient; over a diff the lines showed
  through).
- **⌘L** expands it and puts the keyboard in the prompt (again: back into the prompt). Nothing in
  the keymap uses cmd+l, and the sketch shows it. It is a window capture listener of the composer, not
  a key table row (it is not in the spec's table).
- **After a send it collapses** to the pill: the user full-screened a surface to read it, and the
  pill's dot shows the thread working. A send that fails keeps it open with the draft and the error.
  Escape in it (while no completion or history card is open) or the chip's button collapse it and
  give the keyboard back to the pane; full screen stays. Escape is taken in the card's capture
  phase: the prompt editor marks every Escape handled, so a later check could never see it.
- **Position.** It always opens at the same spot (bottom centre); a drag moves it until full screen
  ends, through collapsing and expanding, clamped inside the pane with a 12px margin. Leaving or
  entering full screen resets it.
- **In full screen a drag drops only in the strip** (or on a space tab): an edge or outer drop would
  make a pane out of sight.

## Visible differences from the sketches (07, 06a, 06b)

- Sidebar: today's classic sidebar (PR 16 is the new one); the sketches show Needs you and Active.
- Rails: the selected icon has a tint and an accent bar (the sketch marks it only by colour, which
  the owner found unclear); a thin divider separates the tabs from the full screen button.
- Full screen strip: the sketch's exit is an icon; here it is "Exit full screen" with an esc chip.
- The pill reads "Message ● thread ⌘L" as sketched, with the thread's status dot (blue while it
  works). The expanded chip reads "to ● thread" with a collapse icon, centred above the card as the
  owner asked (the sketch had it off to the left).
- The diff tab's title is the diff's own ("code-foundry · main vs origin/main"), not "Diff".

## Verification

- `make check` green (numbers in the PR).
- Go: `commands_pane_fullscreen_test.go` (the toggle, on with a pane, off, on and off refused, a pane
  with off refused, from inside a thread refused without `--focus`); the command lists.
- vitest: `shell/fullscreen.test.ts` (the pane shown, entering for another pane, the toggle, a tab
  switch keeps it, the focus moving takes it, off in another space, the floating reset, the params,
  cmd+shift+enter, the pane focus and move keys inert while the tab keys work, Escape's cases, which
  tabs float a composer, the clamp); `components/shell/PaneGrid.rails.test.tsx` (which panes are rails
  at three widths, matching `rails.ts`; a rail mounts no body; the selected mark; the attention dot;
  the tooltip; a click; the rail's full screen; full screen draws one pane at the whole area with no
  gutter and no rails, the exit control, every strip's button); `FloatingComposer.test.tsx` (only for
  linked tabs in full screen; the pill holds no Watch, expanded holds one; ⌘L; the thread's draft; a
  send reaches `thread.send` and collapses; Escape and the chip's button; a tab switch drops it);
  `targets.test.ts` (a rail as one target); `keys.test.ts` (the new row); `PaneTabStrip.test.tsx`
  (the strip's room for the button).
- e2e (WebKit, mock): `shell-rails.spec.ts` (shrinking folds the left pane then the right one,
  growing unfolds them in reverse, the stored tree and its sizes unchanged and no layout verb run;
  WatchThread 2 → 1 → 2 as s-5's pane folds and unfolds; a click on a rail icon unfolds it and the
  other stays folded; a tab dropped on a rail: `tab.move --pane` and the stored tree);
  `shell-fullscreen.spec.ts` (cmd+shift+enter, one pane at the grid's size, the thread's pane and
  stream gone, Escape, the exit control, the strip's button; the pill, ⌘L, the chip centred above the
  card, a send to s-1 and the collapse, the Watch held only while expanded; the draft typed there is
  in the thread's pane after Escape twice; the drag, kept through collapsing, clamped to the pane, and
  reset when full screen ends).
- End to end with `make drive DAEMON=dev` and `?shell=1` on a scratch home under /tmp, with a
  scratch git project under `~/cf-live-scratch` (projects must be under the home; both removed
  after): two Haiku threads in the project and one without. `thread open`, `tab move --outer left`
  and `view open diff` made three panes (Second thread | Rails demo | its diff). At 1000x700 the
  Second thread's pane folded to a rail (the minimal fold: the diff pane fits once it has), its icon
  marked; `layout show` still printed `row [0.50 0.27 0.23]`. A click in the diff, cmd+shift+enter,
  ⌘L, "Reply with just the word pineapple." and Enter: `thread read` showed the message and Claude's
  "pineapple", and the pill came back. Escape left full screen and the thread's pane showed both.
  This run found two bugs, fixed here: Escape did nothing after a click in the diff's file list (a
  `listbox` was excluded), and the expanded card shrank to its text (its column lacked `w-full`).

## Gotchas

- ProseMirror marks Escape handled in the composer's prompt (it calls `preventDefault`), so a
  bubbling listener never sees it as free; take it in the capture phase of something around the
  editor, and leave it to the editor while it has a card open (`aria-controls`).
- `thread.css`'s `.cf-thread .ccard` is unlayered and beats a Tailwind utility of the same
  specificity: an override needs `!`.
- The diff surface writes its own params (path, title) when it mounts: compare a stored tree's
  shape, not its JSON.
- A test that drags by a handle's middle must add the half height to the target point.

## For later PRs

- **PR 16 (sidebar)**: nothing here touches the sidebar; a sidebar click on a thread open in another
  pane moves full screen there (it follows the focus).
- **PR 20 (cutover)**: cmd+shift+enter moves into `pane.fullscreen`'s keybindings with the rest of
  the table; Escape stays the window listener in `Shell.tsx`.
- **Later**: Escape in a full-screened thread's own prompt does not leave (the prompt keeps the
  key, as above); the exit control and the same key do. A rail could also take a whole pane's drag
  by its free space.
