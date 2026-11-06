# Terminal caret and PR panel busy states

Two small fixes reported by a user.

## Missing caret in the bottom panel

All tabs of the bottom panel share one xterm. `XtermRenderer.reset()` calls `term.reset()`, but
xterm 6's `CoreService.reset()` leaves `isCursorHidden` alone, and the daemon's snapshot only
restores modes that differ from the defaults. So a hidden cursor carried over to the next tab.
Two triggers: a terminal exits (`AttachController` calls `hideCursor`), or a tab whose program
hid its cursor is left for a plain shell.

`reset()` now writes `\x1b[?25h`. It has to be a write, not a flag:

- `hideCursor` and program output are queued while reset is synchronous, and `term.reset()` does
  not empty the write queue. A flag set in reset is undone when the queued hide lands afterwards.
  xterm.test.ts has both "still queued" cases; they fail against a flag-only fix.
- The show lands after anything queued and before the snapshot, so a snapshot whose program hid
  the cursor hides it again. An exited terminal hides it after that: the daemon's `attach()` sends
  the snapshot and then `Exited`, and the controller holds `Exited` until the snapshot is parsed.

An ESC is safe behind a chunk that ended inside a sequence: it cancels a CSI and ends an OSC.

The write is caught. xterm throws from `write` while over 50 MB is unparsed, and that is reachable:
a snapshot of output colouring every cell can pass 50 MB, and a tab switch during its replay calls
`reset()` from a React effect. Before this change the first write to fail was the next snapshot's,
in the stream handler, which retries; the catch keeps it that way.

Checked with a dev daemon: a real program that hid its cursor stayed hidden each time its tab was
shown again, and the plain shell beside it kept its caret. Attaching an already exited terminal
could not be run there, because the daemon had removed it; that order is covered in vitest only.

## Busy states in the PR panel

`changing` now holds which change runs (`PrChange`), not a boolean. Any change makes the others
wait, but a button only spins and relabels for its own: otherwise a Convert to draft would show
"Cancelling…" on Cancel auto-merge. `ChangeButton` in ReadinessBox.tsx is the shared button.

Audit of `src/components/pr/*`:

| Action | Before | Now |
| --- | --- | --- |
| Ready for review | aria-disabled only | spinner, "Marking ready…" |
| Cancel auto-merge | aria-disabled only | spinner, "Cancelling…" |
| Convert to draft (⋯) | menu shut, nothing shown | menu stays open, spinner, "Converting to draft…" |
| Revert, Revert changes (⋯) | no busy state; a second press could run it again | `reverting`: spinner, "Reverting…", a second press sends nothing |
| Merge, Auto-merge, thread tasks | spinner already (SplitButton) | unchanged |
| Reviewer rows | spinner already | unchanged |
| Review and Ask composers | spinner already | unchanged |
| Refresh, Refresh diff, Explain, Fix findings | spinner already | unchanged |
| Link to this thread | local to the daemon, toasted | unchanged |
| Open on GitHub, Copy link, Approve on GitHub | nothing to wait for | unchanged |

Decisions and gotchas:

- Convert to draft follows Explain and Fix findings: no confirmation, so the menu can stay open.
- Revert asks first, so its menu shuts for the confirm dialog. The box's button shows the run, but
  the Code tab's compact box has no rows, so the ⋯ button spins too. It also spins for a Convert
  to draft whose menu was closed.
- `reverting` starts before the confirmation, like `merging`: the client cannot see the moment it
  is confirmed, so "Reverting…" shows behind the dialog and goes back if it is declined.
- Auto-merge's SplitButton still spins for any change, as it did. It has one `busy` for both spinning
  and blocking, and splitting that was not worth it for this rare case.
- A reviewer row's press is ignored between the confirmed change and the re-read. The row already
  shows the new state then, so it is left as it was.
- The success toast can show while a button still spins: the command has answered and the detail
  is being read again.

The mock's `pr.revert` now honours `/__mock/gh/pr-delay`, for the screenshots.
