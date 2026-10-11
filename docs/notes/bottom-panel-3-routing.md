# Bottom panel, PR C: every shell in a bottom panel (2026-10-11)

The last of three PRs (A: `bottom-panel-1-daemon.md`, B: `bottom-panel-2-gui.md`).
Shells now show only in a bottom panel: a thread's (`session:<id>`) or the Projects
page's (`view:projects`). The sidebar's Terminals section and the `terminal` selection
kind are gone, and every way to start a shell lands in a bottom panel.

Status: `make check` green (Go packages all ok; 85 vitest files / 1627 tests). `make
gui-e2e` (both browsers, nothing else running): 534 tests, 513 passed, 20 skipped, 1
failed: `zoom-popovers.spec.ts:74` on Chromium (the second right-click's menu does not
open). It is the flake noted in `bottom-panel-2-gui.md` (it failed on the PR A base too);
rerun with `--repeat-each=3` it failed once in three on Chromium and never on WebKit.
The affected specs pass on WebKit and Chromium. `make build` and `make gui-build` green.

## Removed

| Where | What |
|---|---|
| `lib/tree.ts` | Loose terminals, the Terminals header row, `terminalKey`, `headerKey`, `LeafRow`/`isLeaf`, `ownedTerminalIds`, `PlaceableTerminal`, `placeTerminal` (folded into `placeSession`), `leafOrder`, `TreeSession`, `ListSession.terminalId`. `Row` is a thread row only. `buildRows`/`sessionOrder` take sessions alone |
| `lib/termlabel.ts` | Now the home of `SESSION_LABEL`/`WORKTREE_LABEL` (they lived in `lib/tree.ts`) |
| `lib/threadRow.ts`, `lib/path.ts` | `terminalPlace`, `NO_GIT_LABEL`, `terminalLabel` (only the terminal rows and the terminal header used them) |
| `components/sidebar` | `selection.ts`; in `SidebarRow.tsx` the terminal label, state chips and header row; in `RowMenu.tsx` the terminal menu (Kill…/Remove). `RowMenu` takes a thread id. The list's `aria-label` is "Threads"; the arrow keys no longer skip headers |
| `stores/ui.ts` | `{ kind: "terminal" }` from `Selection` |
| `stores/context.ts` | The terminal case of `deriveContext`, and its `terminals` argument (`deriveContext(sel, repos, sessions?, focusedShell?)`); `useTerminalPlacementKeys`, `decodeTerminalKeys`, `useSessionPlacementKeys`, `decodeSessionKeys` (already unused), `getListInputs` (now `getListSessions`) |
| `stores/panel.ts` | The `terminal:<id>` panel key |
| `stores/commands.ts` | The selected terminal's state in the command sync's change check |
| `stores/events.ts` | `promoteTerminalSelection` (replaced, see focusTerminal) |
| `surfaces/*Target.ts`, the Workspace / Usage / Linked PRs surfaces | "A thread's terminal" as a way to reach a thread; `SelectionStores.terminals`; the terminals store in the surfaces' `watches` |
| `App.tsx`, `TerminalPane.tsx` | The plain-terminal content; TerminalPane is session-only (`sessionId` required, no `TerminalTitle`, no Kill Terminal button) |
| `keys/bindings.ts`, `keys/help.ts` | cmd+1..9 jumps to the Nth thread ("Jump to thread 1–9"), not the Nth thread or terminal |
| mock | `t-logs`, `t-tests`, `t-tmp` (no owner) and the `logs`/`exited` kinds and their screens. The seeds keep `t-top` (feat/sidebar's shell, Projects page) and `t-s1-shell` (s-1's shell) |

`kind === "terminal"`, `terminalKey`, `section: "terminals"` and `"terminal:` no longer
appear under `gui/frontend/src`, `mock` or `e2e`.

## Entry points

| Entry point | Lands in | How |
|---|---|---|
| cmd+t, the palette's New Terminal, a `CommandButton` | the selection's panel (a thread's; unavailable on the Projects page, the dashboard and the PR page) | `terminal.new` in the selection's context; the presenter marks pending focus (PR B) |
| A thread row's New terminal here | that thread's panel, selected or not | `newThreadTerminal(id)` |
| The Projects page's project and worktree rows | the Projects page's panel | `newWorktreeTerminal` (PR B) |
| A workspace member's New terminal here, in a thread's side panel (Workspace surface) | that thread's panel | `newThreadTerminal(thread, member path)`: the thread's context plus `--cwd` the member's worktree. The daemon makes the thread the owner and starts the shell there |
| The same row on the Projects page (no thread) | the Projects page's panel | `newTerminalIn` (worktree context), as before |
| The bottom panel's "+" and empty state | its own panel | PR B |
| `code-foundry terminal new` | the owner's panel (thread with `--context-session`, else the worktree's) | the new-shell event opens the panel (PR B) |

Checked and absent: the Worktree surface (`WorktreeOverview`) has no terminal action, in a
thread's panel or the Projects page's, and neither does the composer.

## focusTerminal

`ui.focus.terminal` (CLI: `code-foundry ui focus terminal --id <id>`) emits
`UiIntent.FocusTerminal`. `stores/intents.ts`:

1. A shell: `revealShell` (PR B) selects its owner and opens the panel on it, focused.
2. A thread's Claude terminal (`sessionOfTerminal`: `labels.session`, else the thread's
   `terminal_id`): select the thread, focus its terminal.
3. Not known yet, or its thread is not: remembered. After every terminal or session event
   (and the reconnect's List) `retryFocusTerminal` selects the thread once both are known.
   That is what `promoteTerminalSelection` did for a terminal selection. A pending id
   that arrives as a shell is `revealShell`'s (via `onNewTerminal`). The retry never
   selects a shell's thread itself, because `select(..., { focusTerminal: true })` would
   pull the keyboard from the bottom shell into the Claude terminal.
4. A known terminal with no owner (a raw `TerminalService.Create`): a toast, "Terminal
   <id> belongs to no thread or project". The GUI has no place for it. `terminal list`
   on the CLI still shows it.

## Decisions and gotchas

* **No success toast for a GUI-started shell.** The new tab is the feedback, so every GUI
  `terminal.new` runs quiet: `startShell` (`stores/bottomActions.ts`: row menus, Projects
  rows, workspace members, "+", the empty state) passes `quiet: true`, and the chord, the
  palette and a `CommandButton` invoke through `invokeStarted` (`keys/bindings.ts`), which
  is quiet for the commands in `quietCommands` (only `terminal.new`). A failure still
  toasts; `code-foundry terminal new` still prints "created terminal t-…".

* **No owner, no GUI.** `terminal.new` always sets an owner since PR A, so the only
  unowned terminals are raw `TerminalService.Create` calls. They do not show anywhere in
  the GUI.
* **A daemon without SessionService** shows no rows at all now (threads were the only
  rows left). e2e: the sessions-unavailable test opens the app without waiting for a row
  and checks the Projects page's shell instead.
* **create.spec's project context.** The palette had sketches' context through a selected
  shell row. It now opens the composer from sketches' Projects row ("New thread"):
  `{ kind: "compose", repoId }` carries the repo, which `repo.github.publish` needs.
* **Member shells belong to the thread, not the member.** A shell started from a
  workspace member's "New terminal here" in a thread's side panel is labelled with the
  thread (`session`) and the thread's worktree (`worktree`), not the member's: the daemon
  labels a thread's shell with the thread's place and only starts it in `--cwd`. Removing
  the member's worktree therefore does not reap it (the reaper matches `worktree`);
  removing the thread does. Its shell sits in a directory that is gone until then.
* `proto/codefoundry/v1/command.proto` still names `"terminal"` as an example
  `active_view` in a comment. Changing it means a `make gen` for a comment, so it stays;
  `internal/command/command.go`'s comment says `"session", "projects"`.
* The Help overlay gains one sentence on terminals (⌘T, ⌘J, where they start). Nothing in
  it or the palette mentions selecting terminals in the sidebar.

## Tests

* Unit: `lib/tree.test.ts` (rewritten: `placeSession` table, thread-only rows and order),
  `stores/intents.test.ts` (new: Claude terminal, shell, unowned toast, unknown then
  shell, unknown then thread), `stores/bottomActions.test.ts` (`newThreadTerminal` with
  and without `cwd`), `sessions.test.ts` (the racing FocusTerminal), and the terminal
  rows dropped from the context, panel, surface-target, usage and worktree tables.
* e2e: `e2e/terminal-routing.spec.ts` (new, 4 per browser plus 2 WebKit screenshot runs gated on `SHOTS`: a thread row's menu, cmd+t, a
  workspace member in a thread's panel with `--cwd`, a project row). Rewritten where a
  test selected a terminal row: `app.spec.ts` (sidebar keys, switching threads, typing
  into the bottom shell, the bottom shell's palette context and kill, focusTerminal for
  a Claude terminal / a worktree shell / a thread shell, keyboard navigation and cmd+N),
  `sessions.spec.ts`, `sidebar.spec.ts`, `buttons.spec.ts` (the plain-terminal header
  test is gone; the thread header has no Kill Terminal), `create.spec.ts`, `font.spec.ts`,
  `prs.spec.ts`, `settings.spec.ts`, `usage.spec.ts`, `linkedprs.spec.ts`,
  `worktree-panel.spec.ts`, `live-nogit.spec.ts` (live only). `fixtures.ts`:
  `terminalText(page, "main" | "bottom")`.

## Live run and screenshots

Real app, isolated (`CODE_FOUNDRY_HOME=/tmp/bp3`, the fresh `gui/bin/Code Foundry`), a
scratch repo under home (`repo add` refuses `/tmp`: "outside your home directory"), a
haiku thread, two shells with `terminal new --context-session <id> --argv ...` (labels
`kind=shell session=<id>`), a worktree shell with `--cwd` (no `session`), then
`ui focus terminal --id <shell>` and `--id <Claude terminal>` (each `delivered=1`),
`view bottom toggle`, and `terminal close --id`. `session remove` took the thread's
remaining shell with it, and `repo unregister` took the worktree shell (PR A's cleanup).
The screen was locked the whole session (`CGSSessionScreenIsLocked = true`; a
`screencapture` showed the lock screen), so the window could not be seen or captured, and
nothing was checked visually in the real app.

Screenshots are WebKit against the mock daemon instead, 1440x900 at 2x, in
`docs/notes/bottom-panel-3-routing/` (`SHOTS=<dir>` with the `screenshots` tests in
`e2e/terminal-routing.spec.ts`): `thread-{dark,light}.png` (s-1 with two shells, the one
from its row menu active), `projects-{dark,light}.png` (the Projects page's panel:
feat/sidebar's `t-top` and a shell from dotfiles' row), `sidebar-{dark,light}.png` (the
sidebar: threads only). Copies in `/Users/alex/.t3/userdata/attachments/` carry a
`bottom-panel-3-` prefix.

## Review fixes

Status: `make check` green (Go packages all ok; 85 vitest files / 1646 tests). The touched
e2e specs on both browsers: `terminal-routing`, `app`, `bottom-panel` (64 passed, 4
skipped: the WebKit-only screenshot runs), `worktree-panel`, `panel`, `workspace-panel`
(78 passed, 8 skipped).

| Finding | Change |
|---|---|
| A shell this window started could land in a hidden panel | `focusOwnShell`, and a started shell that arrives later (`onNewTerminal`'s own path), call `uncoverBottom` when its key is the selection's: Settings and Usage close, an expanded side panel goes back to split width (what `revealShell` already did). e2e: a member's New terminal here from an expanded side panel |
| cmd+t did nothing from a Projects-page bottom shell | `deriveContext`'s focused shell is now `{ id, labels }`. For a Projects-page shell (`projectsShellPlace`: owner key `view:projects`, repo and worktree labels, the rule `paneContext` uses for "+") its repo and worktree fill `activeRepoId`/`activeWorktreePath`, so `terminal.new` is available and starts beside it. A thread's shell keeps the thread's place. Unit table in `context.test.ts`; e2e: cmd+t from `t-top` |
| Pending focusTerminal slots never expired | `pendingTerminal` (intents.ts) and `revealOnArrival` (bottomActions.ts) carry a time and are used only within `PENDING_FOCUS_MS`. A timer drops them then, with a "Terminal <id> not found" toast if the id never arrived (none if it arrived but its thread did not). `clearPendingFocus` drops both on a new focusTerminal, focusSession, showView, and any selection change (a `useUiStore` subscription). Tests reset with `clearPendingFocus` |
| The reconnect could miss a pending reveal | `events.ts` calls `revealArrived()` after the List's `replaceTerminals`: a pending reveal whose shell is now known is revealed once |
| Exit overlay lost its e2e | Mock: `POST /__mock/terminal/exit?id=&code=&keep=1` exits a terminal without reaping it (`kill(..., keep)`). `app.spec.ts` checks the bottom shell's overlay ("Process exited with code 1") and the struck-through tab |
| "selected session, terminal, worktree, or page" | `view.panel.toggle`/`expand`/`new-tab` say "selected thread or page" (Go and mock). `view.panel.worktree` needs a thread: a terminal alone no longer counts (a Projects-page shell now brings a worktree, and that page has no thread). Doc comments and the `ActiveView: "terminal"` test contexts use `"session"` |
| Two shells in one folder had the same tab title | `bottomTabTitles`/`bottomTabTitleOf` (stores/bottomPanel.ts): the first keeps the folder name, later ones with the same fallback name get " 2", " 3" in the terminals store's order; an OSC title (threads only) shows as is and takes no number. Unit table; `bottom-panel.spec.ts` expects "feat-sidebar 2" and the thread's three numbered tabs |

The screenshots were retaken after these fixes (the thread's second tab reads
"code-foundry 2").

## Not done

* No real-app screenshots (screen locked).

## Merged with main's Working section (#57)

The stack took main's collapsible Working section (`sidebar-working-section.md`) on top of
the terminal removal. The list's rows are threads plus the one Working header
(`Row = HeaderRow | SessionRow` in `lib/tree.ts`, `isSessionRow`); no Terminals header, no
loose terminals. `buildRows`/`sessionOrder` take sessions and `ListOptions` (no terminals);
`getListSessions` plus `getListOptions` (the UI store's `workingCollapsed`) feed cmd+1..9
and cmd+shift+a, so cmd+N jumps to the Nth thread in the rendered order (a collapsed
Working section's threads do not count). The arrow keys, Home and End skip the header
again (`stepThread`); a right-click on it opens no menu. e2e: `DEFAULT_ORDER` ends at s-1
(s-2, s-6, s-4, s-3, Working, s-5, s-1); the "no terminal rows" checks allow the header.
