# Store-owned state: the Add Project New tab and the shell's mode

An audit of the frontend's effects found two places where a component kept a value that code
outside React reads, and copied it into a store from an effect. The copy could lag the
component or disagree with it. Both now keep the value in one place, the store, and the effects
are gone.

## Add Project, New tab

`NewTab` held `created` (the project it made, awaiting Keep it local or a publish) and `busy`
(create or publish in flight) in `useState`, and two effects copied them to the add-project
store, where `closeAddProject` reads them (refuse to close while busy; delete a created project
on cancel). They now live in the store only: `created: CreatedProject | null` and
`busy: "create" | "publish" | null` (it was a boolean; the tab needs which call runs for its
label). The tab reads them with selectors and writes them with `setNewProjectStep(seq, step)`.

- The suspected bug (`finishAddProject` nulls the store's `created` while the tab's copy stays
  set) was not reproduced. `finishAddProject` also closes the dialog, and every opening remounts
  the tab (`Tabs key={seq}`) with the store reset, so nothing ever reads the two side by side.
  The tests "after Keep it local / a folder added on the Local folder tab, the dialog closes
  keeping the project; a fresh New tab cancelled deletes nothing" pass on the old code and the
  new.
- `finishAddProject` and `closeAddProject` now set only `open: false` and leave `created` and
  `busy` as they were: the dialog fades out (Radix keeps the content mounted for the animation),
  and resetting them there would flip the closing tab's label and created line mid-fade, which
  the old local state never did. `openAddProject` resets both; `closeAddProject` returns early
  once closed, so a stale value is never acted on.
- `seq` guards the writes. An unmounted tab's `setState` was a no-op; a store write is not. If
  the dialog is opened again while a create runs (project.add's intent from a page or the CLI),
  the earlier call's answer must not put its project into the new tab. `setNewProjectStep` drops
  a write whose `seq` is not the current opening's. Test: "reopened while a create runs, the new
  dialog starts fresh and closable; the earlier create's answer does not reach it"; without the
  guard it fails with the old project shown.
- Left alone (unchanged behaviour, outside this change): that earlier flow's own `finish()`,
  when its publish succeeds, still closes whatever dialog is open then; a project created by
  that earlier flow whose publish is refused is kept, not deleted.

## The shell's mode

`Shell` ran `if (ready) setShellMode("shell")` in an effect, `ready` being
`importSettled(loaded, legacyImported, phase)` over the layout and legacy-import stores.
`shellDrawn()` (keys/bindings.ts, stores/views.ts) reads `mode`.

- `mode` is a latch and something relies on it. `loaded` never drops back outside tests and the
  import's `done`/`skipped` phases are final, but a layout snapshot replaces `legacyImported`:
  a window drawn because the daemon's layout had the mark, then sent a snapshot without it (a
  daemon whose import has not run), would compute `ready` false. With the latch the shell stays
  drawn while the window imports into it; a computed getter would tear the pane grid down and
  the selection bridge, focus history and drafts with it.
- So the latch stays in shellView, now set where its inputs change: shell/legacyImport.ts (which
  owns `importSettled` and already imports the layout store) subscribes to the layout and
  legacy-import stores at module load (as stores/fileEdit.ts and others do) and sets
  `mode: "shell"` once settled. `mode` flips in the same tick as the layout or import, not
  after Shell's next commit, so keys and commands never see a drawn grid with `mode` still
  "waiting".
- Gotcha: the subscription exists wherever shell/legacyImport.ts is imported. A test that
  imports it (directly or through Shell) and applies a layout snapshot with the mark now sees
  `mode: "shell"` without rendering Shell; `resetShellView()` puts it back.
