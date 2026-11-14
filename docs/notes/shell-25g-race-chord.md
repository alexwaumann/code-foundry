# Shell 25g: the fresh-shell race, the old dictation chord, one full e2e run

Three follow-ups on the `shell` branch after #712 to #716.

## 1. A tab waiting for its fresh shell is never swept

**The race.** A terminal tab restored as a fresh shell (reopened with cmd+shift+t, a snooze's
set brought back, `Result.Fresh`) names its old, ended terminal from the commit that puts it back
until the layout glue acts on that commit: it starts the shell and points the tab at it
(`ReplaceTerminal`). The quick terminal a snooze ended is the same (`Result.FreshQuick`: drawn
open with no shell until the glue starts one). The glue's sweep (at start and every 60 s) and a
terminal's removal event read the layout as it is now, so either one, run in that window, saw a
held terminal that does not exist and closed the tab (`drop_terminal`) or drew the quick
terminal closed; the glue then found no tab to give the shell to. The window is not
microseconds wide as `shell-25c-keys-drafts.md` said: it lasts until the glue's loop reads the
commit's event, and the loop picks among ready channels at random. The old shell's removal is
the likelier trigger: a quick cmd+w then cmd+shift+t puts the tab back while the glue is still
ending the old shell, and its removal can be read before the reopen's commit.

**The fix: the glue judges only what it has acted on.** The glue already keeps `prev`, the
layout after the last commit it acted on (and resyncs it after dropped events). A terminal is
judged gone (its tab closed) only when `prev` holds it too; a quick terminal is drawn closed only
when `prev` draws it open too. What only the newer layout holds came from a commit the glue has
not acted on yet; it waits (`waiting`, `waitingQuick`) and is judged again right after the glue
acts on the next commit (`settle`, also after a resync). By then the glue has started the fresh
shell and replaced the terminal (nothing to do), or found no checkout or failed to start it and
closed the tab, as before; a tab some other commit opened over a terminal that ended at once is
closed then, not left for the next sweep.

Why not a pending-fresh mark in the layout: it would be a new field in the persisted state, the
proto, the golden op cases, the mock and the fixtures, for something only the glue's ordering
causes; and a mark persisted in a stored layout would need its own rule after a restart. The
glue-side rule needs no state change.

**A restart in the window.** The stored layout has the tab naming its old terminal; the new
glue never sees the commit. Its `prev` is the stored layout, so the start sweep drops the tab
cleanly, as it drops every terminal tab after a restart (no terminal survives one). Nothing
lingers and nothing waits.

**The test controls the ordering.** `newLayoutGlue` builds the glue without its loop or start
sweep (`startLayoutGlue` is it plus both); `layout_race_test.go` applies the ops to the layout
fake (each commit is published before `Apply` returns) and calls the glue's steps itself: the
restore's commit, then `sweep()` or `terminalEvent(removal)`, then the commit's event
(`acted`). Cases: a reopened tab and a snooze's restored set, each with a sweep and with the old
shells' removals in between; the quick terminal with each; a waiting tab whose thread lost its
checkout (it still closes, no shell); a restart in the window. With the check removed the six
race cases fail ("closed before its fresh shell started"); with it all pass. No sleep, timeout
or retry is involved.

**End to end.** The window cannot be opened on purpose from the CLI (it needs the glue's loop
to read a removal or a tick before a commit queued microseconds earlier), so the Go test is the
evidence. A scratch daemon run checked the flow around it is unchanged (see Verification).

## 2. The old dictation chord is cleared from users' settings

- Until 2026-11-03 `dictation.toggle` had cmd+shift+m by default; the hold key replaced it and
  `pane.collapse` has cmd+shift+m now (#714). A file binding `[keybindings] "dictation.toggle" =
  "cmd+shift+m"` got "cmd+shift+m is already bound to pane.collapse".
- `internal/store/settings/file.go`: `retiredChords` (keybinding key -> the chord it once had by
  default) beside `retiredKeys` and `movedKeys`, applied in `decode` like them. A file that binds
  `dictation.toggle` to exactly cmd+shift+m, in any spelling the keybinding parser reads as that
  chord (`Shift+Cmd+M`, `⇧+⌘+m`, `command+shift+m`, an unquoted dotted key), reads as unset: no
  issue, `dictation.toggle` has its default (no chord; the hold key dictates), cmd+shift+m
  collapses a pane. The next write of the settings leaves it out of `settings.toml`. Any other
  chord on `dictation.toggle` (and "none") stays, and so does cmd+shift+m on another command.
- `decode` is also what `settings.Read` uses, so CLI verbs that read the file without a daemon
  agree.
- Tests: `chord_test.go` (table: the spellings, other chords, other commands, an unparsable
  value kept for its issue; and through the store: the file written without it, other values
  kept).
- The dictation e2e test's sample user chord stays cmd+shift+y: cmd+shift+m is now a chord the
  daemon clears for that command, so a test of "a user's chord toggles dictation" with it would
  test the wrong thing.

## 3. The whole e2e suite on the combined branch

`make gui-e2e` once on this branch (`shell` at #716 plus the two changes above; WebKit, 4
workers, the mock daemon, no other suite running): **565 passed, 167 skipped, 1 failed**.

- `linkedprs.spec.ts:35` "the sidebar tag opens its pull requests as tabs in the thread's
  panel, the shown one's surface, and the prompt keeps no focus": the PR surface showed #147
  where #12 was expected. Alone it passed 3 runs of 3; with `--repeat-each=12` over 4 workers it
  failed 1 of 12 the same way, so it does reproduce alone, rarely. Not touched: it is not a
  regression from #712 to #716. The likely cause predates them: the tag's click
  (`LinkedPrsBadge.tsx` `openLinked`) opens the rest and then the shown one so that the shown
  one's tab ends active, but each open is its own `LayoutService.Apply` request sent without
  waiting for the one before (`hostShell.ts` `shellOpenTab` -> `apply`), and two requests in
  flight may reach the daemon (here the mock) in either order. Neither file changed in today's
  PRs. Left for its own fix (send the opens in order, or the shown one's open after the
  others resolve), with a unit test of the order.

## Verification

- `make check` green.
- Item 1: the Go tests above are the evidence for the window itself. On a scratch daemon
  (`daemon --dev`, a new `CODE_FOUNDRY_HOME` under the session's temp folder, removed after):
  `terminal.new-free`, then `tab.close` and `tab.reopen` back to back 25 times; after it one
  tab, over one running shell, nothing left over. After a restart on the same home: no tabs, no
  terminals.
- Item 2: the same scratch home started with `"dictation.toggle" = "Shift+Cmd+M"` and
  `"thread.new" = "cmd+shift+n"`. `settings.get`: `keybindings.dictation.toggle = ""`, no issue,
  `keybindings.pane.collapse` cmd+shift+m. After `settings.set appearance.font_size 14` the file
  has no `dictation.toggle` line and keeps `"thread.new" = "cmd+shift+n"`.
