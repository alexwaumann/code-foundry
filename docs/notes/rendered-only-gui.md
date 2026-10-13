# Rendered-only threads: the GUI

Status: done on the GUI side (`gui/frontend`: src, mock, unit tests, e2e) on top of the
proto change da935b0 (`SessionRender`, `Session.terminal_id`, `Session.render`,
`CreateSessionRequest.render`, `UiContext.active_session_rendered` gone). The daemon side
is `docs/notes/rendered-only.md`. Every thread is a rendered thread (claude -p over
stream-json, drawn from its items by `components/thread`); the PTY stack stays for the
bottom panel's shells only.

## Deleted

| What | Where |
|---|---|
| `TerminalPane` (a thread's Claude terminal in the content pane) | `components/terminal/TerminalPane.tsx` |
| The disconnected page: `SessionDisconnected`, `DisconnectedFrame`, `StatusPill`, `MetaLine` | `components/session/SessionParts.tsx` |
| The header's "rendered" badge (`data-testid="session-render"`) | `SessionTitle` |
| `disconnectedPill` / `PillKind`, `modelEffortLabel`, `sessionLocation` / `LocationRepos` (only the disconnected page used them) | `lib/session.ts` (+ tests) |
| `SessionView.terminalId`, `SessionView.render`, `SessionRenderView` | `api/session.ts` |
| `UiContextView.activeSessionRendered` (and its `contextKey` part) | `api/command.ts`, `stores/context.ts` |
| `sessionOfTerminal`, `retryFocusTerminal` and the thread-terminal branch of the focusTerminal intent | `stores/sessions.ts`, `stores/intents.ts`, `stores/events.ts` |
| The composer's View picker (`composer-render`), `Draft.render`, `ComposeRender`, `RENDER_CHOICES`, `DEFAULT_RENDER`, `PromptArgsInput.render`, session.new `--render` | `components/compose/Composer.tsx`, `lib/compose.ts`, `stores/compose.ts` |
| The `render === "rendered"` gates: MCP surface/target, cold-cache note, Escape-interrupts | `surfaces/mcpTarget.ts`, `components/mcp/McpSurface.tsx`, `lib/coldCache.ts`, `ColdCacheNote.tsx`, `keys/bindings.ts` |
| The `"terminal"` focus region | `stores/ui.ts`, `App.tsx` `regionOf`, `stores/views.ts` |
| Mock: `t-claude` / `t-ghostty`, `MockSession.terminalId` / `render`, `sessionTerminal`, the claude terminal kind (`claudeIntro`, `claudeTick`, `/exit`, typed-input-clears-attention), `sessions.render`, `viewOf`, session.new `render` | `mock/world.ts`, `mock/screens.ts`, `mock/settings.ts` |
| `e2e/composer-view.spec.ts` (its "the prompt goes out as the first message once Claude is up" moved into `compose.spec.ts`) | |

## Simplified / moved / renamed

* `App.tsx` `Content`: a selected session is always `ThreadPane`, now **eager** (no `lazy`/
  `Suspense`): it is the app's main content, the lazy chunk only saved lowlight on the
  dashboard and cost a blank frame on the first thread.
* `ThreadPane` gained the minimal not-found state the disconnected page used to own
  (`data-testid="session-missing"`: "This thread no longer exists." / "Loading thread…").
  A disconnected thread shows its conversation and `ThreadComposer`'s Reconnect card.
* `HeaderActions` moved to `components/thread/HeaderActions.tsx`. Header test ids renamed
  `terminal-header` → `thread-header`, `terminal-title` → `thread-title`.
* `TerminalHost` serves only the bottom panel: no `name`, `region`, `onSize`, `onRenderer`
  or children. The dev hook is one `window.__cfTerminal` (the bottom host); e2e reads
  shell text and the font through it, and loses its WebGL context in the fallback test.
* `ui.terminalFocusSeq` → `promptFocusSeq`, `select(sel, { focusTerminal })` →
  `{ focusPrompt }`; `keys/bindings.ts` `focusContentTerminal` → `focusThreadPrompt`.
* `ui.closePalette` no longer has a terminal target; `closeSettings`/`closeUsage` ask for
  prompt focus only when a thread is selected (no stale request for the next composer).
* focusTerminal intent: `revealShell` or a toast. A known terminal that is no owned shell
  says "belongs to no thread or project" at once; an unknown one waits
  `PENDING_FOCUS_MS` for `revealShell`'s on-arrival path, then "not found".
* `mock`: `addRenderedThread` → `addScriptedThread`; thread.* and MCP commands are offered
  whenever a thread is active (`when: activeSessionId`). The six seeds get a short history
  (`MockThreads.seed`): s-1 mid-reply (streaming), s-2 a pending Bash permission (its
  status reason is now `permission: Bash zig build -Doptimize=ReleaseFast`), s-3 / s-6 a
  finished turn, s-4 cut mid-turn, s-5 nothing yet (starting).
* MCP login hint: "run claude in a shell and use /mcp, then reconnect" (no terminal
  thread to run /mcp in).

## Keyboard and focus (behaviour kept, mechanism new)

A selected thread puts the keyboard in its prompt (the TipTap editor) instead of an xterm.
Three things were needed to keep what the terminal did:

1. **Chords from the prompt.** A text field swallowed every command chord, so cmd+j,
   cmd+shift+w, cmd+r, cmd+t died in a thread. `ThreadComposer`'s root carries
   `data-chord-yield`; `handleKeyDown` treats it like `[data-terminal-host]`: bound cmd
   chords (not the editing ones) run, everything else stays in the editor.
2. **Focus requests across remounts.** `ThreadComposer` is keyed by thread, so the
   selection's `promptFocusSeq` bump lands before the new composer mounts. The last
   handled prompt seq is module-level; content requests (`contentFocusSeq`, the side
   panel hiding) stay per instance. A composer that mounts with no request (Show
   worktree, a revealed shell) leaves the keyboard where that put it; the keyboard's place
   at request time is kept across StrictMode's effect replay (`request` ref). Under an
   expanded side panel the panel takes the request (as `TerminalPane` did). A disconnect
   or reconnect while shown moves the keyboard to the Reconnect button / prompt unless it
   is in the bottom panel (the old page's `autoFocus`). A composer mounted at least a frame
   ago focuses synchronously (after Escape closes the palette, a chord pressed in the next
   frame would otherwise land in the closing palette input and be swallowed); a fresh
   composer, or a prompt that just replaced the Reconnect card, waits a frame, because
   StrictMode recreates its TipTap editor and an early focus hits the discarded one.
3. **TipTap's late refocus.** `editor.commands.focus()` focuses again a frame later
   (WebKit), which took the keyboard back from a palette opened right after selecting a
   thread (cmd+k typed into the prompt and Enter sent it). `PromptEditor`'s handle now
   focuses synchronously (`view.focus()` + `scrollIntoView`), for the new-thread composer
   too.

## e2e

* `fixtures.ts`: `terminalText`/`expectTerminalText` read `window.__cfTerminal` (no
  host argument); new `threadPrompt(page)`.
* Terminal-thread checks became timeline checks: selection shows `thread-pane` with
  `data-session-id` and the seed's `thread-user`; switching keeps one
  `ThreadService/Watch` (sessions.spec's budget test: one EventService.Watch plus one
  thread Watch, no Attach); keystrokes/exit overlay/WebGL loss/font/theme go through s-1's
  bottom shell; Reconnect via the card (`thread-disconnected`, `reconnect`), with focus
  checks; "typing clears attention" is now answering s-2's docked permission with 1;
  FocusTerminal on a thread terminal is gone, an unknown id now asserts the "not found"
  toast; the disconnected page's pill test is the Reconnect card's causes plus the header.
* Bottom-panel Attach counts dropped by one (no content-pane Attach); the panel's surface
  list gained MCP for s-1; the Remove test uses the row menu (the page's Remove button is
  gone; the card has none).
* Live specs (`live.spec.ts`, `live-prsession.spec.ts`) were rewritten against the
  timeline but **not run** (they need a real daemon with the rendered-only Go side).

## Gotchas

* `[data-chord-yield]` also covers the docked prompts' buttons; they are not editable, so
  nothing changes for them.
* A fresh composer's prompt focus is deferred one frame; e2e waits with `toBeFocused()`
  before pressing chords.
* The production bundle grew by the thread chunk (lowlight) now that `ThreadPane` is eager;
  Vite's >500 kB chunk warning was there before.
* A thread selected under the Projects page's or a stale contentFocusSeq does not grab
  focus on mount: only `promptFocusSeq` is shared across composers.
