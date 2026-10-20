# Copied feedback on every copy button (2026-10-20)

Every copy icon button in the GUI now confirms the copy the way a thread's code blocks
always have: the icon turns into a lucide `Check` and the button's name (aria-label, and
its tooltip where it has one) reads "Copied" for 1.5 s, then returns.

Decided with Alex:

1. **One hook.** `lib/useCopied.ts`: `useCopied(ms = COPIED_MS)` → `{ copied, copy(text) }`.
   `copy` runs `copyText` (`lib/clipboard.ts`) and sets `copied` only once the text is on
   the clipboard; it resolves `false` on failure and shows nothing.
2. **Icon buttons get the check, no toast.** The plugin `CopyIconButton` stopped toasting;
   `copyElementText` (a plugin's `copy` action on a non-icon element) still toasts. The
   Linked PRs row's Copy link no longer calls `copyPullRequestLink` (which toasts "Link
   copied"); it copies through the hook and toasts only "Copy failed".
3. **Left alone:** the PR menu's Copy link (a dropdown item that closes on select, so its
   toast stays its feedback; also the PR surface's shift+cmd+c), and the terminal's
   selection copy (no icon).

## Pieces

| File | Change |
|---|---|
| `lib/useCopied.ts` (+ test) | the hook and `COPIED_MS` (1500) |
| `components/thread/CodeActions.tsx` | `CopyButton` on the hook; no visual change |
| `components/files/FileHeader.tsx` | `CopyPathAction` on the hook; no visual change |
| `components/plugin/parts.tsx` | `CopyIconButton` on the hook: check only, no toast; aria-label "Copied" while copied, `data-copied` |
| `components/thread/ToolDiffView.tsx` | Copy diff split into `CopyDiff` (own state, so the memoized diff below does not re-render on a copy); check + "Copied"; `data-testid="thread-diff-copy"` |
| `components/thread/rows.tsx`, `thread.css` | `CopyAnswer`: check + "Copied", `data-copied`; `.copy-answer[data-copied]` keeps it visible after the pointer leaves the answer |
| `components/linkedprs/LinkedPRsSurface.tsx` | the row's Copy link: check + "Copied"; the hover-only action group gets `flex` while copied so it stays shown |

## Decisions

* **Tooltip label while copied.** CodeActions' `CopyButton` has its own "Copied" text, so
  its tooltip goes away (label null) while copied, as before. The icon-only buttons (Copy
  path, plugin Copy, Copy diff, Copy answer, Copy link) have no text, so their tooltip
  label reads "Copied" instead of vanishing. In practice the tooltip is closed after the
  click anyway (Tip stays shut after a press until the pointer leaves).
* **A second copy restarts the wait.** The hook keys its timer on a counter of successful
  copies, not on `copied`, so copying again at 1.2 s still shows the check for a full
  1.5 s (the old per-button effects let it lapse at the first copy's deadline).
* **Copy link's state lives in the row,** not in a child, because the row decides whether
  its hover-only action group shows; the row re-renders twice per copy, which is cheap.
* **No colour change.** Only CodeActions' button turns emerald when copied (unchanged);
  the others keep their colours, as Copy path and the plugin button already did.

## Tests

* `lib/useCopied.test.tsx`: table test over the timing (fake timers), recopy restarts the
  wait, failure resolves false with nothing shown, unmount clears the timer.
* `components/thread/rows.test.tsx`: Copy answer reads "Copied" with `data-copied`, then
  returns.
* e2e `thread.spec.ts`: Copy diff and Copy answer show "Copied" and return; Copy answer
  stays at opacity 1 after the pointer leaves, then hides. `linkedprs.spec.ts`: Copy link
  shows "Copied", no "Link copied" toast, stays visible after the pointer leaves.

## Verification

* `make check` green; `make gui-e2e` green (WebKit, 463 passed, 26 skipped).
* Live: `make gui-build`, the built app on an isolated home (`CODE_FOUNDRY_HOME=/tmp/…`),
  a no-project Haiku 5.5 thread (medium) asked for a short answer. Hovering the answer
  shows Copy answer; clicking it puts the answer's markdown on the clipboard and turns the
  icon into a check, which stays after the pointer leaves the answer and goes 1.5 s later.
  Dark and light screenshots of the check are in the PR body
  (served from the `cf/copy-feedback-shots` branch).

## Gotchas

* A synthetic click in the live app moves the real pointer and writes the real clipboard:
  the screenshot run left the test answer on the clipboard.
* `make check` failed once on `TestPollCacheRestart` (internal/store/gh, a timing flake
  unrelated to this change; it passed 5/5 alone with -race and the next full run).

Frontend only: no daemon restart needed.
