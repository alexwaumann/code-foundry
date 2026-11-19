# Threads open as, part 2: the GUI

Part 1 (`threads-open-as-1-rules.md`) built the rules of `layout.threads_open_as` in the daemon
and kept today's chrome. This part gives the GUI its look under Panes and Single, the setting's
dropdown and the switch dialog. The sidebar is the thread switcher, so a pane that shows one
thread had a tab strip of one tab plus a header row under it: wasted chrome. Part 3 changes the
default for new installs.

## How it is built

- **Which pane is headed.** `shell/threadsOpenAs.ts` reads the setting (`useThreadsOpenAs`) and
  says which pane draws the header row (`headedTab`): under Panes and Single, a pane whose only
  tab is a thread's or a composer. Anything else, and every pane under Tabs, keeps its strip.
  `PaneView` draws `ThreadPaneHeader` in place of `PaneTabStrip` and tells the surface through
  `ShellPane.headed`, so `ThreadPane` leaves out its `ThreadHeader`. The row is the strip's 44px,
  so the conversation gains the old header's 40px (checked in e2e).
- **The row** (`components/shell/ThreadPaneHeader.tsx`) reuses the parts it replaces: the tab's
  icon and `StatusDot`, `PlaceChip`, `TranscriptDeletedChip`, `PanePlusMenu`, `ThreadInfoToggle`,
  `ThreadHeaderMenu`, `PaneCollapseButton` and `FullscreenButton`. It is the pane's drag handle
  (`usePaneDrag`) and the tab's context menu trigger (`TabContextMenu`), merged as a strip's tab
  merges them (`lib/mergeHandlers.ts`, moved out of `PaneTabStrip` for fast refresh). The buttons
  stop the pointer press so they are not the grip. A composer's row has its label and only the
  "+" and pane buttons. The name element carries the tab's dom id, so the pane stays labelled by it.
- **The row's "+"** is `PanePlusMenu` with `threadPane` (`thread-pane-plus-menu.md`): named
  "Open"; the thread's surfaces (`ThreadSurfaceItems`) at the top level under "This thread"; New
  thread beside (`composer.new --beside <pane>`) under Panes and no New thread under Single; the
  rest as a strip's "+".
- **Drops** (`shell/drag/targets.ts` `SceneModes`, built by `ShellDnd` `sceneModes`): a thread
  pane's row and middle are one target, the pane (no places in a row of one tab); they take a
  thread (sidebar row, a thread's tab) or a thread pane, not another tab or a pane of them (the
  daemon would only move it out again). Under Single a thread is offered no edge, pane or outer:
  every drop replaces the space's thread pane's thread anyway. `shell/drag/modeDrop.ts` names
  what a thread's drop does: the preview's label is "Replace <thread>" or "Open beside", and the
  screen reader's over and dropped lines add "dropping replaces <thread>" / "it replaced …".
  The measured strips include the row's title, so a headed pane is named by its thread.
- **Open beside** (`components/sidebar/shell/OpenBesideItem.tsx`): first in a thread row's
  Open ▸ under Panes only; `thread.open --beside <pane>` with the target thread pane of the
  thread's space (`besidePane`: as Go's `threadPane`, the focused pane when it holds a thread,
  else by the space's MRU). Not shown when that space has no thread pane or the thread is open
  there already.
- **The setting.** The schema gives the three options their descriptions (`EnumDescriptions`,
  which the dropdown already draws under each name) and the row's own description; the row keeps
  that description rather than the picked option's (`ownDescriptionKeys`). `ThreadsOpenAsEditor`
  wraps the enum editor: a pick toward Panes or Single first runs
  `layout.threads-open-as.preview` and saves at once when it closes and moves nothing, else asks
  in the app's confirm dialog (`components/settings/threadsOpenAsSwitch.ts` writes the words with
  the counts). Cancel saves nothing, so the controlled dropdown stays on the daemon's value.
- **Smart swap held on.** `keyHeld` registers a hook per setting that another setting holds:
  `layout.smart_swap` under Panes and Single. Its editor shows a disabled switch that is on, its
  description gets "Always on while threads open as Panes or Single.", and the reset arrow hides
  (it would write the default over the user's own value). The stored value is never written.

## Decisions

- **Rename.** A thread's tab has no rename field of its own: its Rename edits the name in the
  sidebar (and cmd+r). The row keeps exactly that, from its context menu and its "…" menu.
- **Preview.** A preview tab is marked by dashes, not italics, so the row's title (icon and name)
  carries the same dashes, a double click keeps it, and the "…" menu has Keep open as before.
- **Ember's thread** has its own header under the row (`EmberPane`): its row shows the name and
  the pane's buttons only, no branch chip, info toggle or thread menu.
- **A subagent's view** keeps its own header under the row, as it did under the strip.
- **Drops of other tabs on a thread pane** are not offered under Panes and Single (the daemon
  would move them straight out into a pane on the right); edges still are.
- **The dialog's tone** is the confirm dialog's default warning (it closes tabs), not a new tone.
- **Counts.** "N other thread tabs" counts composers too. To Single, the closing panes are
  counted, with the thread tabs in brackets when there are more tabs than panes; when no pane
  closes but a kept pane has other thread tabs, those tabs are counted. The "Nothing is lost"
  paragraph shows only when a thread closes. When the preview fails (an old daemon), the switch
  is made without asking: it loses nothing.
- **Palette.** `settings.set` is `NoPalette`, so the palette cannot switch the setting; the
  confirm lives in the settings page only. A CLI or file edit converts without asking (part 1).

## Gotchas

- The mock remembered the last mode it converted to across `/__mock/reset`, so a spec that set
  Panes made the next spec's switch to Panes a non-change and nothing converted. `reset()` now
  forgets it.
- `CommandButton` draws nothing for a command the commands store does not list: a component test
  of the row seeds `view.thread-info`.
- No zoom workaround was needed: the row uses the strip's height constant and measures nothing.
