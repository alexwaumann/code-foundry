# Shell 25c: keys, Needs you, draft rows and a thread's unsent text

The owner tested the `shell` branch and decided five more changes. `shell-model.md` was edited
first (one commit), then each was built.

## 1. cmd+t and the free terminal

- cmd+t (`terminal.new`, presented by the window: `shell/terminalActions.ts` `newTerminalTab`)
  opens a terminal linked to the focused tab's thread as before; with no thread there it opens a
  free terminal in the home directory (`terminal.new-free`).
- **Kept, and written into the spec's key table:** from a checkout's shell of no thread (a shell
  the Projects page started), cmd+t still starts another shell in that checkout. The brief says
  "a free terminal in the home directory when there is no thread in context"; that case was not
  discussed, an e2e test pins it (`terminal-tabs.spec.ts`), and a new shell beside the one being
  typed in is what a terminal's new-tab key does. The "+" menu's general Terminal stays a free one.
- The sidebar selection no longer decides: only the focused tab's thread does (the selection
  follows the focused tab in the shell anyway).
- `terminal.new-free` keeps its verb and its palette entry (New Terminal in Home Folder) without a
  key.
- Gotcha: where no thread or checkout owns a shell the daemon lists `terminal.new` unavailable, so
  its chord did not bind at all (cmd+shift+t was the only way there). A first fix made it
  startable everywhere (`contextSupplied`), which also listed it in the palette next to the free
  terminal's own entry and enabled its buttons; it is now `chordSupplied` in `keys/bindings.ts`:
  only the keymap binds it there.
- `plugin-streams.spec.ts` opened its free shell with cmd+shift+t; it now runs the palette's verb.

## 2. cmd+shift+t reopens the last closed tab or pane

- **Where it lives.** `Space.Closed` in `internal/layout` (newest first, `MaxClosed` = 20), stored
  in the space's row document (`SpaceDoc.closed`), so it survives a restart and goes with its space
  when the space is removed. The window never reads it: it is not in the proto snapshot.
- **What records.** The ops `close_tab`, `close_pane` and `close_thread` take `record`; only the
  verbs `tab.close`, `pane.close` and `thread.close` set it, and only for the user
  (`Context.FromUser`: the app, or the CLI outside a thread). That covers cmd+w, a tab's ×, a
  middle click, a terminal tab's Close menu item, a thread header's Close, cmd+shift+w and the
  pane's close. A model's close (a thread's CLI) does not record. Everything else that takes tabs
  out (archive, snooze, `move_thread`, `remove_space`, the glue closing a tab whose shell exited,
  a composer replaced by its thread, linked tabs put away with their thread) runs other ops or
  runs these without `record`, so nothing is recorded on its own.
- **Entries.** A tab: the tab (its key dropped, recomputed on reopen), its pane, its index and,
  when it was its pane's only tab, `BesideInfo` of that pane. A pane: its tabs, its active tab and
  `BesideInfo`. `close_pane` now puts away each thread's linked tabs first, records the pane as it
  is then (the thread tabs still in it), then closes the thread tabs: the same steps as before in
  a different order (every existing case passes unchanged), so the entry holds the thread's own tab
  and not the linked tabs its remembered set has.
- **The space's empty composer is never recorded.** A draft's tab is: it reopens the draft while
  the space still lists it. Closing a draft's tab keeps the draft as before; the sidebar row and
  cmd+shift+t both bring its tab back.
- **Reopening** (`reopen_closed`, verb `tab.reopen`, cmd+shift+t):
  - a tab goes back into its pane at its index while the pane is in the space;
  - **difference from the brief:** when its pane is gone and it was the pane's only tab, the pane
    is rebuilt where it sat (as a pane entry is) instead of the tab being placed by the usual
    rules. cmd+w on a one-tab pane is the common way a pane goes; reopening it as a tab in another
    pane would not undo it. Placement is the fallback when no old neighbour is left;
  - otherwise placement: a thread's tab as `open_thread` puts it (the focused pane, or in place of
    an ephemeral composer), a linked surface by the placement rules, anything else in the focused
    pane;
  - a pane comes back beside those of its old neighbours still there, at its old share
    (`groupRun` and `insertBeside`, as `putBack` rebuilds a remembered pane). **Where it goes
    otherwise (left to me):** the right edge of the whole pane area at its active tab's kind's
    size, as a pane dropped there (`toOuter`); in an empty space it is the only pane;
  - a pane and a tab take their old ids back while free. Their ids count as used while in the
    history (`usedIDs`), so no new pane takes one meanwhile; a pane id named by a thread's
    remembered set is still free for it (`paneID`), which is what lets the thread's linked tabs go
    back into the rebuilt pane;
  - a thread's tab (alone or in a pane) brings its remembered set back (`restore`) and its quick
    terminal if a snooze ended it;
  - a terminal's tab keeps its manual name and its old terminal id, loses its `ran` param (no "Run
    again" line), and is listed in `Result.Fresh`. The daemon's glue (`internal/daemon/layout.go`
    `fresh`) starts a shell: in the thread's checkout for a thread's terminal (linked again), and
    now in the home directory with free labels for a free one (before, a fresh tab without a thread
    closed), then points the tab at it (`replace_terminal`);
  - skipped and dropped: tabs the verb names in `gone` (a thread archived or not listed, a file tab
    whose path, read from its `base` when relative, no longer exists), tabs whose identity no longer
    validates, a thread's tab whose thread now lives in another space, a draft no longer listed in
    the space. In a pane's entry only those tabs are left out;
  - what is open again (same identity) is focused where it is (`Result.Existing`), and the entry
    dropped;
  - the reopened tab (a pane's: its active tab when it closed, also when that was a linked tab the
    thread's set brings back into it) takes the focus; the window's presenter moves the keyboard
    into its pane.
- **Nothing to reopen.** The op succeeds with no tab named (it still drops the dead entries). The
  CLI says "nothing to reopen in space …"; in the app the key does nothing, like the other keys
  that find nothing to do. The verb has no `When`: the command list is not re-read after a close,
  so availability would go stale.
- **The PR tab's identity.** A pull request tab is skipped when its identity no longer validates
  (`Identify`); nothing else about a pull request is checked (it may be merged or closed: the tab
  shows that).
- **Proto.** `ReopenClosedOp` and `record` on the three close ops, for the `LayoutOp` case every op
  must have; the window does not send them (it runs the verbs).
- **The mock** keeps its own simplified history on `MockLayout.closed` (its verbs are rebuilt on
  every listing, so a closure lost it: found by the e2e test), cleared by a seed or a reset. The
  record cases are skipped in its port of the Go cases ("the reopen history").
- **Race left alone:** a sweep (every 60 s) that runs between a reopen's commit and the glue's
  fresh shell sees the old, ended terminal id and closes the tab. The snooze restore has the same
  window; both are microseconds wide.

## 3. Needs you lists only actionable asks

- `lib/thread.ts` `isActionableAsk`: a permission (and "waiting for approval"), a question (and
  "waiting for input"), a plan, a folder trust dialog.
- The sidebar list key's last field was `woke`; it is now `nudge`: the "prompt" group without an
  actionable ask (a woken snooze, a notification or bell, an API error at the prompt, "blocked:",
  "continue:", "menu:" and unknown reasons, a plugin's attention flag). Such a thread is placed
  exactly as a woken one was (top of Active below the pins and the drafts, most recent first, a
  pinned one stays with the pins) and counts in nothing of Needs you: the section, the space tabs,
  the top bar's control and cmd+shift+a all read `needsList` / `needsBySpace`.
- Its row keeps its status until opened, as before: what clears it is the daemon's, unchanged.
- The dock badge and the other attention counts outside the sidebar are not Needs you and were
  left as they are.

## 4. Draft rows

Line 1 is the place its thread will start in, drawn as a thread row draws its own: the project
with its kind's icon, a workspace with the workspace icon and name, a "like" draft as the source
thread's place, and "No project" with the house icon; Discard on hover at its right. Then the
title, the label in a thread title's weight, or "Untitled draft" muted and italic as before. Then,
where a thread shows its branch, the pencil and "Draft". The amber tint is unchanged. The row's
size estimate is a thread row's now.

## 5. A thread's unsent text

A thread's composer keeps its text in the compose store under `thread:<id>`
(`lib/threadDraft.ts`), in memory, shared by the floating composer. It is now kept by the drafts'
mechanism (`shell/composerDrafts.ts`): the same localStorage entry, `code-foundry.shellDrafts`, as
`{ v: 1, texts, threads }` (`threads` is new; an old entry reads as having none), written 250 ms
after a change and on stop, put back at start. Text only: the drafts' mechanism keeps no
attachments or citations, so neither does this. The send clears the draft, so storage follows;
a thread archived or no longer listed loses it, once the threads list has loaded (before, every
thread is unknown). localStorage because the drafts' text is there: one place for unsent text,
per window profile, and nothing the daemon or another machine needs.

## Tests

- Go: golden cases for the three close ops with `record` (a tab, a pane's last tab, the empty
  composer, the cap, a thread, a pane with a thread) and for `reopen_closed` (nothing, into its
  pane, the pane rebuilt, placed, a linked tab placed by the rules, a pane beside or on the edge or
  alone, a thread with its set, a thread rebuilding its pane, a pane holding a thread, a terminal,
  skipped entries, a pane partly gone, the identity open again, a draft); the fuzz now records and
  reopens; a stored history round-trips and is sanitised; entries reopen in turn; the store keeps
  the history across a reload; the verbs record for the user only and skip an archived thread, a
  removed one and a missing file; the glue starts a fresh shell for a reopened thread's terminal
  and a free one.
- vitest: cmd+t with no thread, from a checkout's shell, from the + menu; the chord where the
  daemon lists `terminal.new` unavailable; the key table; the list keys of every attention kind;
  the sections; the draft row's lines; a thread's text stored, restored, cleared and dropped; the
  mock's reopen.
- e2e (`shell-keys-drafts.spec.ts`): cmd+shift+t after cmd+w, from the pane and from a thread's
  prompt, with the keyboard back in the pane; cmd+t on a tab of no thread opens a free terminal with
  the keyboard in it; SHOTS of the sidebar, also run on the tree before the change.
- End to end: a scratch daemon and the CLI: a Pull Requests tab, a free terminal renamed "Logs"
  split off into a pane of its own, the terminal's tab closed (its shell ended), the other pane
  closed, the daemon restarted, the history still there, `tab.reopen` twice (the pane back at its
  place and id, then the terminal tab back in its pane with a fresh home shell under "Logs"), then
  "nothing to reopen".
