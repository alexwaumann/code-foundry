# Bottom panel: cmd+j opens a shell, the last exit hides it (2026-10-13)

User feedback on the bottom terminal panel (`bottom-panel-2-gui.md`,
`bottom-panel-3-routing.md`), decided with Alex:

1. Opening a panel that has no shell starts one (cmd+j, the header's toggle, the
   palette's Toggle Bottom Panel), instead of showing "No terminals".
2. A panel whose last shell goes (it exits, `exit` is typed, × / cmd+w / Close Terminal)
   hides, whether or not it is on screen, so the next cmd+j starts a fresh shell. The
   daemon-restart pruning leaves panels closed too.
3. A small helper, `openBottomShell`, that a later "Run in terminal" button on code
   blocks can call.

Status: `make check` green (Go packages all ok; 112 vitest files / 2194 tests). e2e on
both browsers for the touched specs (`bottom-panel`, `app`, `archive`, `font`, `layout`,
`sessions`, `terminal-routing`, `no-project`, `panel`): 186 passed, 12 skipped (the
WebKit-only screenshot runs). Live: `e2e/live-bottom.spec.ts` against a real daemon
(below), 2 passed.

## Pieces

| File | Change |
|---|---|
| `stores/bottomActions.ts` | `openBottomShell(key, { fresh?, command?, args? })`, `toggleBottomFromHere()`, `closeEmptyPanels()`, `hideEmptyBottom` (private); `newBottomTerminal` is `openBottomShell(key, { fresh: true })`; `onRemovedTerminal` hides a panel that lost its last tab |
| `stores/bottomPanel.ts` | `starting` (per key, not persisted) with `markStarting` / `clearStarting` / `isStarting` / `useBottomStarting`; pure `emptyOpenKeys(byKey, terminals, starting)` |
| `stores/views.ts` | `bottomCanShow(key)` (no settings/usage page, side panel not expanded); `toggleBottomCommand` stays the plain toggle |
| `keys/bindings.ts` | The `view.bottom.toggle` presenter calls `toggleBottomFromHere` |
| `stores/events.ts` | `closeEmptyPanels()` after the reconnect's List |
| `components/bottom/BottomPanel.tsx` | Blank body (`data-starting`) instead of the empty state while a shell is starting |
| `components/help/HelpOverlay.tsx` | One sentence on both behaviours |
| `internal/command/commands_view.go`, mock | `view.bottom.toggle`'s description: "In the app, opening it with no terminal starts a shell." |
| `mock/world.ts`, `mock/server.ts`, `mock/hub.ts` | `POST /__mock/terminal/new?delay=&fail=`, `POST /__mock/daemon/restart`, `Hub.endAll()` |

## Decisions

* **Only this window's toggle starts a shell.** The presenter (cmd+j, `BottomToggle`'s
  `CommandButton`, the palette) runs `toggleBottomFromHere`. The CLI's `view bottom
  toggle` reaches every window through `ShowView "bottom.toggle"`, which keeps the plain
  `toggleBottomCommand`: one CLI call must not start a shell per window. The shell itself
  is still a registry command (`terminal.new` via `runCommandForResult`), so no user action
  lives outside `internal/command`.
* **When it starts one.** The panel is closed, could show (`bottomCanShow`: under Settings,
  Usage or an expanded side panel cmd+j stays a no-op, as before), has no tab, no start is
  already in flight for the key, and `paneContext(key)` exists. A thread always has one.
  The Projects page has none without a tab, so there cmd+j shows the empty state's hint
  ("Start one with New terminal on a project or worktree row."). The dashboard and the
  PR page have no key at all.
* **Closing stays a plain hide.** cmd+j / × on an open panel never closes or starts shells.
* **No "No terminals" flash.** `openBottomShell` marks the key as starting before it opens
  the panel, and the body stays blank (`data-starting`) until the shell arrives (the mark
  clears in `showOwnShell`), the run fails (cleared at once; the empty state shows as the
  fallback), or `PENDING_FOCUS_MS` passes (a timer clears only its own start, by
  timestamp). The panel opens at once, before `terminal.new` returns, so cmd+j feels
  instant; focus goes to the panel, then to the shell when it arrives (the existing
  by-id pending focus).
* **"+" keeps the keyboard where it is.** `openBottomShell` only shows/focuses the panel
  when it is not already on screen, so "+" in an open panel does not pull focus into the
  old tab while the new shell starts (the button's `onMouseDown` preventDefault already
  relied on that).
* **Hiding on the last tab.** `onRemovedTerminal` (every `removed` event: exits, reaps,
  closes, archive cleanup) checks the store after the removal; no tab left means
  `hideEmptyBottom(key)`: open → false for that key whether or not it is visible. If it
  was on screen, focus goes to the content pane when it was in the bottom panel
  (`focusContent`, like cmd+w on an empty panel), or the palette's `returnTo` moves from
  `"bottom"` to `"content"`. A key with a start in flight is left open (the shell is about
  to fill it).
* **Restart pruning.** The reconnect's List removes terminals without `removed` events,
  so `startEventSync`'s `onConnect` calls `closeEmptyPanels()` after `replaceTerminals`:
  every open entry with no tab and no start in flight hides. This also covers a persisted
  open state (localStorage) for a key whose shells are gone at startup.
* **The empty state is a fallback now**: a failed `terminal.new`, the Projects page with
  no tab, and the window between a persisted state and the first List. cmd+w on it still
  hides the panel.
* **The helper for "Run in terminal".** `openBottomShell(key, opts)` resolves to the
  shell's id (reused or new; a new one may not have arrived yet) or null (no context; or
  `terminal.new` failed, which toasts). `fresh: true` always starts a new tab; `command`
  types the line into the new shell with `TerminalService.Write` plus Return (`\r`, a
  trailing newline is dropped), so the shell stays open after the command; `args` passes
  `terminal.new` args such as `cwd`. Focus and uncovering only apply when the key is the
  selection's. The follow-up PR wraps it in a registry command (every user action is a
  command) and decides how a multi-line block is sent.

## Gotchas

* **Typeahead before the prompt.** Input written right after the shell starts is echoed by
  the PTY before zsh draws its prompt, then zsh runs it: the live screenshots show
  `echo autoshell-$((6*7))` once above the first prompt and once after it. Harmless (it
  runs once), but a "Run in terminal" that writes immediately will look like that. The
  follow-up may want to wait for the first output (an Attach event) before writing.
* **Re-opening by arrival.** cmd+j starts a shell, then cmd+j again hides the panel before
  the shell arrives: the shell's arrival (by-id pending focus) opens the panel again. Same
  as "+" before this change; not worth a cancel path.
* The `onRemovedTerminal` unit tests must update the store before calling it (the events
  handler's order), because the "last tab" check reads the store after the removal.
* `mock/hub.ts`: `while (!signal.aborted && !ended)` with a closure-set `let ended`
  trips `no-unnecessary-condition` (TS narrows it to `false`); it reads an object field.
* WebGL bottom hosts have no DOM text: the live spec reads `window.__cfTerminal`.
* Running Playwright while other worktrees run theirs: pass `E2E_MOCK_PORT` /
  `E2E_VITE_PORT`, and check them with `lsof` first. Another agent's mock took 7841/9341
  between two of these runs ("is already used"); 7863/9363 were free.

## Tests

* `stores/bottomPanel.test.ts`: `emptyOpenKeys` table (Claude terminal does not count,
  closed, starting, Projects page), start marks (per key, expiry, clear by timestamp), the
  persist round trip without `starting`.
* `stores/bottomActions.test.ts`: the last tab going (shown with keyboard → content focus;
  keyboard elsewhere; another thread selected; palette `returnTo`; a tab left; a start in
  flight; the Projects page; the Claude terminal), `closeEmptyPanels`, `openBottomShell`
  (reuse, start with blank body and arrival, fresh with args and command, failed write,
  failed run, no context, unselected key), a `toggleBottomFromHere` table (empty thread,
  thread with a tab, hide, Projects page, settings, dashboard, start in flight) and the
  palette's `returnTo`.
* `e2e/bottom-panel.spec.ts` (21 per browser): rewritten where the panel used to open
  empty (palette on s-2, the toggle and "+", a disconnected thread, × on the last tab);
  new: cmd+j with a 600ms `terminal.new` (blank body, never the empty state, one run,
  focus), `exit` hides it and the next cmd+j starts a fresh one, hide/show starts nothing;
  a hidden thread's last shell exiting closes its panel; the Projects page's last shell
  and the hint; `POST /__mock/daemon/restart`; a persisted open panel with no shells; a
  failing `terminal.new` (empty state, cmd+w hides, its button starts one).
  `e2e/app.spec.ts`: the kill test expects the panel gone.
* `e2e/live-bottom.spec.ts` (live only): see below.
* Go: only `view.bottom.toggle`'s description and a comment changed; no behaviour, no new
  Go test.

## Live run and screenshots

Real daemon from this worktree (`CODE_FOUNDRY_HOME=/tmp/cf-autoshell/home`,
`bin/code-foundry daemon --dev`), a no-project haiku thread (`session new --no-project
--model 'claude-4.5-haiku[1m]' --effort medium`, no prompt), the Vite dev server pointed
at it, and `e2e/live-bottom.spec.ts` in WebKit (`LIVE_DAEMON=1 LIVE_SESSION=<id>
LIVE_APP_URL=… LIVE_SHOTS=…`):

1. cmd+j on the thread: one tab ("No project"), attach live, never the empty state, the
   keyboard in the shell; the daemon lists exactly that shell for the thread.
   `echo autoshell-$((6*7))` prints 42.
2. `exit`: the daemon reaps the shell, the panel hides, the prompt has the keyboard, the
   daemon lists no shell.
3. cmd+j: a fresh shell with a new id, focused. cmd+w: `terminal.close`, the panel hides.
4. Second test: panel open on a new shell, the page navigates away, `terminal close` on
   the CLI, the page comes back: the persisted open panel stays closed (the List on
   connect, the same path a daemon restart takes). A real daemon restart was not run
   live: it picks a new port and token, which the Vite dev server has baked in.

Screenshots (`docs/notes/bottom-panel-autoshell/`): `thread-dark.png`,
`thread-light.png`, the panel right after cmd+j and the echo, 1200x720 at 1x. They are
the browser build against the real daemon, not the Wails window.
