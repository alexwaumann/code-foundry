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

* **No owner, no GUI.** `terminal.new` always sets an owner since PR A, so the only
  unowned terminals are raw `TerminalService.Create` calls. They do not show anywhere in
  the GUI.
* **A daemon without SessionService** shows no rows at all now (threads were the only
  rows left). e2e: the sessions-unavailable test opens the app without waiting for a row
  and checks the Projects page's shell instead.
* **create.spec's project context.** The palette had sketches' context through a selected
  shell row. It now opens the composer from sketches' Projects row ("New thread"):
  `{ kind: "compose", repoId }` carries the repo, which `repo.github.publish` needs.
* **The Projects page's bottom shell gives the palette no project context.**
  `focusedBottomShell` only sets `activeTerminalId`, so cmd+t from a Projects-page shell
  still does nothing (as in PR B). Not changed here; it would be a context rule of its own.
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

## Not done

* No real-app screenshots (screen locked).
* A Projects-page bottom shell still gives the palette no project context (above).
