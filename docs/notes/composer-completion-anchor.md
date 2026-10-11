# Composer completion anchor: the `/` and `@` card no longer moves the composer

Status: done on branch `t3code/composer-completion-anchor`. GUI only, on top of the
completion card from `composer-tags-3-skills.md` and `composer-tags-4-files.md`.

Before, the card sat in flow between the composer card and the worktree/base row. The
start page centres the composer vertically, so opening the card pushed the composer up by
half the card's height, and closing it dropped it back.

## What landed

| Path | What |
|---|---|
| `gui/frontend/src/components/compose/CompletionCard.tsx` | absolutely positioned under its parent (`absolute inset-x-0 top-full mt-2 z-10`, flex column); `fit` / `useFitBelow` cap its height to the space left below it; the list scrolls itself |
| `gui/frontend/src/components/compose/Composer.tsx` | the card's in-flow grid row is gone; the worktree row is `relative` (`data-testid="composer-worktree-row"`) and holds the card as its last child |
| `gui/frontend/src/lib/zoom.ts` | `zoomFactor()` (reads `--cf-zoom`) |
| `gui/frontend/e2e/composer-skills.spec.ts`, `composer-files.spec.ts` | anchoring and fitting assertions (below) |

## Decisions

* **Anchor**: the card hangs under the worktree row, out of flow, as wide as the composer
  card (the row spans both grid columns, so `inset-x-0` on it is the card's width). Neither
  the composer card nor the row changes its box when the card opens or closes. Error and
  notice lines stay between the card and the row, in flow, as before.
* **Height**: `fit` takes the distance from the card's top to the visible bottom, the
  smaller of the window's bottom and the composer section's (the scroll container; the
  pane ends 8px above the window), less 16 layout px. That caps the card
  (`max-height`). When the list's room is below its own cap (`max-h-[15.5rem]`, ~8 rows),
  the list is capped to whole rows (28px rows, 8px padding), so no row is cut by the
  hints; with room, the list keeps the original 15.5rem (and its half-row peek).
* **Very short**: below two rows plus the hints, the hints footer hides (`data-short` on
  the card, `group-data-[short]/completion:hidden`) and the space goes to rows. The card
  never gets shorter than one row; only then (a window so short that the worktree row is
  within ~55px of the pane's bottom) can it run past the margin.
* **Zoom**: rects (`getBoundingClientRect`, `innerHeight`) are viewport px under WebKit's
  and Chromium's standardized `zoom`; `max-height`, `offsetHeight` and `scrollTop` are
  layout px. `fit` divides the distance by `zoomFactor()` (`--cf-zoom`). Verified at 90%
  (the smallest ladder step; there is no 80% step in `ZOOM_LEVELS`), 100%, 125% and 150%.
* **Refit**: on open, window `resize`, zoom change (effect dependency), the section's
  `scroll`, and a `ResizeObserver` on the card itself (rows come and go, Searching… →
  rows) and on every ancestor up to the section (a growing prompt re-centres the
  composer and moves the card with it; a zoom change resizes the section in layout px).
  The style is set imperatively in a layout effect, so the first paint is already fitted
  and nothing re-renders.
* **List scrolling**: `scrollIntoView({block:"nearest"})` could also scroll the
  composer's section; the list now scrolls itself. The delta comes from rects (viewport
  px) divided by the zoom and rounded up, since the list's height is fractional under zoom
  and `clientHeight` is rounded (an `offsetTop` version left the last row 1px under the
  edge at 90% and 150%).
* **Unchanged**: `useCompletion.ts`, keys, mouse (mousedown kept from stealing focus,
  hover selects, click inserts), listbox/option ids and the prompt's
  `aria-controls` / `aria-activedescendant`, the card's surface and row styling.

## Gotchas

* Absolutely positioned descendants count towards a scroll container's scrollable
  overflow. Fitting the card to the section's bottom (not just the window's) keeps it
  inside the section's padding box, so opening the card never adds a scrollbar.
* At the e2e's 1280x800 viewport the full ~8-row list does not fit under the centred
  composer (the list gets 223px at 100%); the "full height" assertions use 1000px.
* System Events' `first process whose unix id is N` plus `keystroke` sends keys to
  whatever is frontmost; with several "Code Foundry" processes and another app in front,
  keystrokes went to a different Code Foundry window. The screenshots used a small Swift
  helper that checks `NSWorkspace.frontmostApplication` is the target PID, posts the key
  events with `CGEvent.postToPid`, and captures by window id (`screencapture -l<id>` from
  `CGWindowListCopyWindowInfo` filtered by owner PID).

## Verified

* `make check` green (gofmt, vet, staticcheck, `go test -race ./...`, frontend
  typecheck, lint, vitest).
* e2e (WebKit + Chromium):
  * `composer-skills.spec.ts`: the first test records the composer card's and worktree
    row's boxes before typing `/dep` and asserts them unchanged once the card is open,
    the card's top at or below the row's bottom, same x and width as the composer card,
    bottom inside the window. New: at 100% and 125%, `/` (3 rows), `/z` (No skills
    match) and Escape leave both boxes unchanged.
  * `composer-files.spec.ts`: new, at 90/100/125/150% in a 1000px window with 21 `@src`
    rows: boxes unchanged, card under the row and as wide as the composer, bottom at
    most 16 layout px above the section's bottom; at 90/100% the list is the full 248px,
    zoomed in it is whole rows ending within a row of the margin (a missing or doubled zoom
    division fails this); ArrowUp to the last row keeps the composer still and the row
    inside the list; Escape leaves both boxes unchanged. A 560px window shows
    fewer whole rows with the hints; resizing to 1000px refits to 248px; to 400px drops
    the hints and still fits.
  * All other composer specs (`compose`, `composer-switch`) pass unchanged.
* Live (isolated `CODE_FOUNDRY_HOME=/tmp/completion-pr`, this repo added with
  `repo.add --path`, `@session` in the composer): screenshots below; the heading sits at
  the same pixel row with the card closed and open. Zoom and theme were switched with
  `settings.set` while the card stayed open, so the refit on zoom is exercised live.

| | |
|---|---|
| closed, 100% | `composer-completion-anchor/closed-100-dark.png` |
| open, 100% dark / light | `open-100-dark.png`, `open-100-light.png` |
| open, 90% | `open-90-dark.png` |
| open, 125% dark / light | `open-125-dark.png`, `open-125-light.png` |
| open, 150% | `open-150-dark.png` (3 whole rows) |
| open, 560pt window | `open-100-short-dark.png` (3 whole rows) |

## Daemon restart

None: frontend only.
