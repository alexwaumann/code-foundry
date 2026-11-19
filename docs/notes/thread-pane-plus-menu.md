# A thread pane's "+"

Under `layout.threads_open_as` Panes and Single a pane that shows a thread (or a composer) draws
one header row (`ThreadPaneHeader`), and its "+" was the tab strip's menu as is: "Open a tab", a
"This thread" label over a submenu named after the thread, then New thread (cmd+n), Terminal,
Pull Requests, Projects and the Plugins list. A user found it misleading: in a thread pane nothing
it lists opens as a tab there. Surfaces go to another pane by the placement rules, and New thread
replaced the pane's thread with a composer. Agreed from a sketch, and built as agreed.

## Decisions

- **"Open", not "Open a tab".** The tooltip and accessible name say what the button does without
  promising a tab in this pane. The plus icon stays. A strip's "+" keeps "Open a tab": there it is
  true.
- **The thread's surfaces are flattened.** The pane is that thread, so a submenu row named after
  it repeated the header. `ThreadSurfaceItems` renders straight under the "This thread" label, then a
  separator: the same items, order, "open" marks, Terminals label and actions as the submenu had
  (a pick passes this pane, which the daemon passes over for a thread pane and places by the
  rules, as before). A composer's row has no thread, so no group, as before.
- **New thread beside, Panes only.** Replacing the shown thread is what cmd+n and the sidebar do;
  the "+" of a thread pane is the place to ask for a second one. It runs
  `composer.new --beside <pane>`: a composer in a new thread pane on this pane's right, focused,
  this pane's thread left in place. No chord is shown, because cmd+n is not that action and keeps
  doing what it did. Under Single a space shows one thread pane, so the item is left out (the
  daemon refuses `--beside` there, as `thread.open --beside`). It is also left out on the pane of
  the space's empty composer: a space has one, so the pick could only focus that same composer (a
  draft's pane keeps it). This one was not in the sketch; it came up while driving the app.
- **`composer.new --beside`** is a new flag (the daemon's `new_thread` op gained `Beside`), not a
  new verb: it mirrors `thread.open --beside` (a pane id or a thread id; not with `--pane`;
  refused under Single with the same error). It works under Tabs too, as `thread.open --beside`
  does. The space has at most one empty composer: one open in another pane moves to the new pane
  (its old pane closes when that was its only tab, which a thread pane's composer always is); one
  already in the pane asked for is focused where it is. A new pane that does not fit opens folded
  ("No room"). No proto change: the GUI reaches it through the command, as `thread.open --beside`.
- **The variant is a prop** (`PanePlusMenu threadPane`), not a second menu: the Terminal item with
  its untabbed terminals, Pull Requests, Projects, the Plugins list and the terminals-only rule
  are shared as they were.

## Gotchas

- The mock daemon reimplements the layout (`mock/layout.ts`): `new_thread` with `beside` is
  mirrored there (`newThreadBeside`) and `composer.new` takes `--beside` in `mock/layoutVerbs.ts`.
- `e2e/shell-grid-fuzz.spec.ts` finds a strip's free space by the "+" named "Open a tab"; a thread
  pane's header is not a strip, so it is right that it no longer matches there.
