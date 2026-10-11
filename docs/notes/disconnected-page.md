# Disconnected thread page redesign

Frontend only (no proto or Go). Design record: `docs/sketches/disconnected-page`
(`index.html?v=e`, the approved variant; `approved.png` is the approved render).
The page builds on the status persistence from `thread-status-persistence.md`.

## Layout

`SessionDisconnected` (`components/session/SessionParts.tsx`) uses the start page's and
composer's frame: a `relative flex-1 flex-col` wrapper with `<Backdrop />`, a `relative`
scrolling section holding an `m-auto` column (max 480px, gap 20px, centred text), and
`<DragBand />`. Top to bottom: status pill, thread name (22px semibold), the guidance
line, the meta line, Reconnect / Remove. The plug icon, the "Not connected · reason"
line, the facts table, the worktree path and the 14vh offset are gone. The missing /
loading state (`session-missing`) uses the same frame.

## Status pill

`disconnectedPill` (lib/session.ts) maps the persisted status; the cause is
`disconnectCause`, which is `disconnectReason` lowercased except "Claude exited…".

| status      | reason       | `data-status-kind` | dot                         | label              |
| ----------- | ------------ | ------------------ | --------------------------- | ------------------ |
| error       | any          | interrupted        | red (`bg-red-400`)          | Interrupted        |
| attention   | any          | attention          | amber (`bg-amber-400`)      | Was waiting on you |
| idle        | `finished`   | idle               | hollow ring, muted border   | Finished           |
| idle        | other        | idle               | hollow ring, muted border   | At prompt          |
| busy/unknown| any          | none               | none                        | (omitted)          |

So the pill reads e.g. "Interrupted · crashed (exit code 1)", "Was waiting on you ·
daemon stopped", "At prompt · Claude exited", or just "not running" for kind none.
While a reconnect is pending the pill shows a spinner and "Reconnecting…".

* Any `error` status maps to Interrupted, not only reason `"interrupted"`: the store
  sets error only as "interrupted" (the mock refuses any other), so the other case is
  hypothetical and red/"Interrupted" is the closest honest reading.
* Red: the sidebar has no session error colour yet; `red-400` is the red it uses for a
  failed terminal exit (`SidebarRow` `TerminalStatusIcon`). Amber matches
  `SessionStatusIcon`'s attention dot.
* The ring is 7px (the sketch's size) so the 1.5px border leaves a visible hole; the
  filled dots are 6px.

## Meta line

`<ago> · <location> · <model>`, `text-xs`, faint `·` separators, wraps centred.

* **Location** (`sessionLocation`, lib/session.ts): `placeSession` over every repo's
  worktrees, then that repo and worktree entry. Git: `project @ branch`, the short head
  (7 chars) when detached (falls back to whichever of branch / head is non-empty).
  No git (`RepoView.git === false`): the project name alone. Unplaceable:
  `basename(worktreePath)`. The span's title is the full worktree path.
* **Model** (`modelLabel`): the composer's `MODEL_CHOICES` label ("Opus 5.5"), the raw
  id when unknown, plus ` (<effort>)` with the raw effort value. Omitted with no model.

## Gotchas

* `DragBand` is `z-10` across the top 44px. `PanelToggle` lives inside the scrolling
  section (so it paints above the backdrop) and needs `z-20` to stay clickable; the
  section sets no z-index, so it is not a stacking context and the toggle wins.
  panel.spec's "worktrees and the Pull Requests page have their own panels and toggles" clicks it.
* `data-focus-root`, `tabIndex` and the `session-disconnected` test id stay on the
  section (panel.spec asserts that element is focused and contains the toggle).
* Selectors: the page reads `id in byId` and the name; the pill, cause, model and
  location are separate narrow selectors (`useShallow` for the object-returning ones).
  `sessionLocation` runs inside the repos selector, cheap enough on every repos event.
* e2e: `disconnect-reason` assertions are lowercase now ("crashed (exit code 139)",
  "closed"), including live.spec.ts. Mock seeds already fit (s-3 idle opus/medium in
  `fix/resize`, s-4 haiku in `feat/sidebar`); unchanged.
