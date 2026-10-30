# Remove the dashboard: the No project composer is home

> The dashboard page (`view.dashboard`, the start page with its greeting, counts and
> thread list) is gone. The window's home is the new-thread composer on No project with
> the project picker closed: `HOME = { kind: "compose", projectId: "", noProject: true }`
> in `stores/ui.ts`. A user chose this; a later PR puts a Welcome heading and a prefilled
> prompt on the composer for a user with no projects.

## What moved where

* **Daemon:** `view.dashboard` and `command.ViewDashboard` are removed
  (`internal/command/commands_view.go`). The capabilities `pages` group lists 5 pages.
  A ShowView named `dashboard` (an old daemon, a script) is an unknown name: the GUI
  ignores it (`viewNames` no longer has it).
* **GUI selection:** `DASHBOARD` and `isDashboard` are gone; `HOME` replaces them. The
  window starts on it (`selection` and the `history` seed), and every fallback selects
  it: `stores/archiveCleanup.ts` (the selected thread archived, snoozed or removed) and
  the composer's Escape with nothing typed (`Composer.tsx`: a like draft goes back to
  its thread, a project or workspace composer to Projects, No project stays on HOME).
* **`kind: "none"`** renders HOME's composer (App.tsx `Content`, which also falls back
  to it for an unknown page). Nothing sets `none`; its panel key stays null and its
  command context is `emptyContext`, which is now HOME's (`activeView: "compose"`, no
  project), so the palette offers on it what it offers on HOME.
* **Start page removed:** `components/start/StartPage.tsx`, `lib/greeting.ts` and their
  tests, the zero-projects Welcome copy, `activeThreadIds` (its thread list) and
  `useProjectStructureKeys` / `decodeProjectKeys` (only it read them). `Backdrop` and
  `DragBand` stay: the composer uses both. `appearance.backdrop`'s description no longer
  names the start page.
* **History:** cmd+[ / cmd+] start from `[HOME]`. HOME is never pruned (no project to
  lose), so back past the first entry returns false and the window stays on HOME.
* **Docs:** GETTING-STARTED.md (the Guide tab, and the help skill's
  `reference/getting-started.md` built from it) says the window opens on a No project
  thread. It also no longer names the sidebar bell, which #413 removed: the window title
  and the Dock badge count what is waiting.

## Decisions

* **Picker closed on landing.** HOME is a plain selection, never `thread.new`: the
  project picker is a palette page only `thread.new` opens, so selecting HOME renders the
  composer directly. The composer focuses its prompt on mount, as before.
* **HOME has a side panel** (`compose:home:`, as the No project composer always had);
  the dashboard had none. No bottom panel, as for any composer.
* **Daemon tests that used `ActiveView: "dashboard"`** to mean "a GUI page with nothing
  selected" now use `pullrequests`, not `compose`: the compose view offers `thread.new`,
  which several of them assert is unavailable.
* **The mock** drops its `view.dashboard` command to mirror the daemon.

## Gotchas

* The No project composer was already `compose` with `noProject`; `sameSelection`
  treats it as equal to HOME, so a history test that pushed it after the seed now pushes
  a project composer instead (adjacent equal entries collapse).
* A home with a focused prompt means plain keys typed right after load go to the prompt;
  cmd chords still reach the app (`data-chord-yield`), but cmd+[ in a text field stays
  with the field, so the e2e test clicks out of the prompt before stepping back.
* **A cmd chord before the first command list was lost in the prompt.** In a prompt only
  a chord some listed command declares waits for a re-list; before the first list none
  is declared, so cmd+, pressed as the window opened (the prompt now focused, where the
  dashboard left the body focused) did nothing. `keys/bindings.ts` now holds a non-editing
  cmd chord until the first list arrives (`contextKey === null`), as it does outside the
  prompt; cmd+arrows, cmd+backspace and the like still edit. The settings and memory
  specs caught it as flakes.

## Verification

* `make check`.
* Playwright WebKit against the mock (`make gui-e2e`): new `home.spec.ts` (zero
  projects, opening with projects, Escape and the heading picker staying home, cmd+[,
  backdrops) replaces `start.spec.ts`; archive, snooze, sidebar, layout, buttons,
  bottom-panel, app, theme-editor-fuzz and transcript-deleted specs moved to HOME.
* Full run: 724 passed, 42 skipped, 1 failed. The failure, `e2e/actions.spec.ts:60`
  (the header's Play menu right before the bottom toggle), fails on origin/main too: the
  thread info toggle sits between them. Not this change; left for its own fix.
* Live: `make build && make gui-build`, the real app on a scratch `CODE_FOUNDRY_HOME`:
  the window opens on the No project composer with no picker; a one-word No project
  thread, focused then archived from the CLI, lands on it; `view.back` (cmd+[) three
  times goes to the archived thread, then home, then stays home; dark and light.
