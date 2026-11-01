# Thread info card: the wheel chains to the conversation natively

Status: done on branch `cf/thread-info-wheel-native` (one PR, GUI only). Replaces the
wheel part of `docs/notes/thread-info-scroll.md`; the card's place, the `--ti-inset`
contract and the scrollbar are unchanged.

## Symptom

A user, wheeling over the thread info card while it was shorter than the pane, saw the
conversation scroll but the newly exposed edge stay blank: the top after scrolling toward
older content, the bottom after scrolling toward newer. The blank filled in only once they
wheeled anywhere outside the card. Their settings: zoom 100, compact density, dark theme.

It never reproduced: not in Playwright WebKit, not in a dev WKWebView, not in the
production build driven with synthesized trackpad and mouse HID events (CGEvent scroll
phases, momentum, line notches). The likely cause is script-driven scrolling at wheel
rate in a composited WebKit scroller: the card's `onWheel` dispatched a synthetic `wheel`
on the timeline and then `scrollBy`, once per event, on the main thread, while WebKit's
scrolling thread and tile coverage expected the scroll to come from its own wheel
handling. Missing tiles or a stale virtualizer range at the new edge both fit what the
user saw. No harness showed either, so the fix removes the mechanism instead of patching
around one.

## The design change

* **The card lives inside the timeline's scroller.** `TimelineList` takes `pinnedLayer`
  (Timeline passes it through), drawn inside the scroller before the rows' `.col` in a
  box that is `position: sticky; top: 0; height: 0`, overflow visible,
  `pointer-events: none`, `z-10`. It takes no height and never moves, so the rows'
  offsets (the virtualizer's `paddingStart`, every measurement) are as before.
* **A wheel over the card is the browser's.** The aside (`thread-info`) is absolute at
  the box's top right, `-right-(--ti-inset)`: over the scroller's right padding, 320px
  wide (`--ti-card` less `--ti-gutter`), `py-3`, so the card sits exactly where it was
  (12px from the pane's top and from its right edge, the scrollbar to its right). The
  aside stays `pointer-events-none` and the card `pointer-events-auto`, so the 12px
  strips above and below the card pass through as before. The aside is
  `max-h-(--timeline-h)` and `overflow-y-auto` with its scrollbar hidden: a card taller
  than the pane scrolls itself, and at its end a new gesture chains to the list (macOS
  latches a gesture to the scroller it started in; acceptable). A card shorter than the
  pane cannot scroll, so the wheel goes straight to the list by native chaining.
* **`--timeline-h`**: the list's client height, set by TimelineList on the pinned box from
  a ResizeObserver on the scroller (written to the element's style, so a resize renders
  nothing). The box is inside the scroller, so the aside cannot size from the body any
  more.
* **Input**: the scroller's `onWheel` is now reached by wheels over the card through the
  DOM, so `markInput` counts them as the reader's input and the list unpins on a wheel up
  ("Jump to bottom" shows) exactly as for a wheel over the rows. The forwarding (`forward`,
  `LINE_PX`, the synthetic event, `scrollBy`, `scrollerRef`) is deleted.
* **Portals**: React bubbles events from portals through their React ancestors, which now
  include the scroller. The scroller's four input handlers (wheel, touch move, scroll
  keys, pointer down) ignore events whose target is not in its DOM (`inList`): a wheel
  over a card menu or hover card scrolls that layer and is no input to the list. This
  also applies to rows' own portalled menus, which reached the handlers before; those
  scroll themselves and were never meant as input. Nothing else in Timeline reacts to
  bubbled events (`onScroll` does not bubble in React 17+).
* **Pinch and sideways wheels** need no handling: the browser does what it does over any
  part of the list.
* **`overflow-x-hidden`** on the scroller while a layer is pinned: the aside ends exactly
  at the padding box's right edge, and a subpixel at another zoom must not make the list
  scroll sideways. Without a layer the scroller's classes are as before.

## What changed in thread-info-scroll.md's contract

* The card is no longer the body's absolute aside beside the column; it is inside the
  scroller. Everything else in that note holds: `--ti-card`, `--ti-gutter`, `--ti-inset`,
  the scroller's `padding-right`, the thin scrollbar in the gutter, the dock's `right`,
  the jump chip, the catching-up chip, the loading and empty messages, the page modal's
  `right`.
* The wheel paragraph and its two gotchas (the portal filter in the card's handler, the
  synthetic wheel before `scrollBy`) are superseded by this note.
* `paneBox` (`cite/reveal.ts`) now finds the card inside the body
  (`[data-testid="thread-timeline"] [data-testid="thread-info"] > [data-testid="thread-info-card"]`)
  instead of as the body's sibling. Same test ids.
* **Focus order**: the card is now before the rows in the DOM, so Tab from the header
  reaches the card's rows before the conversation's; before, it came after the composer.
  The card is a column of facts and the composer keeps its own shortcut, so this is
  accepted as is.
* The card now sits inside `PaneOverlay`, `KeepRowContext` and `HoldTopContext`. Nothing
  in the card reads them; the page modal still covers only `right-[var(--ti-inset)]`, so
  the card stays usable beside an expanded page.

## Unchanged

Ember's chat, the subagent view and the inline thread use Timeline or TimelineList
without `pinnedLayer`: no box is rendered and the scroller's classes and handlers behave
as before (the portal filter aside). `ThreadInfoOverlay` (the floating card on a narrow
pane) is untouched and still scrolls only itself.

## Gotchas

* Children of a scroller cannot paint over its scrollbar: the aside has to end at the
  padding box (`-right-(--ti-inset)` from the content box), not at the body's edge as the
  old aside did with `pr-3`. The card's box is the same either way.
* The pinned box must stack over the rows (`z-10`): a sticky element paints before the
  later `.col`'s positioned rows otherwise.
* Pass `undefined`, not `false`, for no layer: TimelineList decides by `!= null`.

## Tests

* `e2e/thread-info.spec.ts`, unchanged and green: the geometry (scroller to the pane's
  edge with a 12px scrollbar, card 12px from the edge, rows and composer left of it), a
  wheel under the card, a wheel over a short card unpins and stays up with Jump to bottom
  left of the card and returns on a wheel down, a tall card scrolls itself and not the
  list, a page's Expand leaves the card uncovered and usable.
* New in it, on the mock's new `long` state (forty turns, `mock/thread.ts`): twelve
  120px wheels over the card at a trackpad's pace move the list over 1000px up, and
  `elementsFromPoint` finds a mounted row under the list's top and bottom edges; the same
  after more wheels up and eight back down (short of the bottom). A wheel over the card's
  project menu leaves the list where it was and pinned.
* `e2e/citations.spec.ts` (the Cite button and popover left of the card) green with the
  new `paneBox` selector.
* The new e2e cases also pass on main's forwarding: no harness reproduces the blank edge,
  which is why the mechanism went rather than a guard on it.

## Verified

* `make check` green.
* `make gui-e2e` (4 workers): 736 passed, 10 failed. Four are the known ones on main
  (`thread-project-set` "Add project: one pick", three `subagent-view` model-name
  tests). Five passed on a rerun (3 repeats each): `composer-threads` :116, `panel` :593,
  `plugins` :51, `thread-info` :28, `thread` :717 (Jump to bottom). `thread-prompts` :236
  (question keyboard) fails 2 runs in 3 here and the same on main's Timeline and card, so
  it is not this change. `inline-page-shows` :66 failed once under load in a targeted
  run and passed 16 of 16 repeats.
* The built app (`make gui-build`) on an isolated home (`CODE_FOUNDRY_HOME=/tmp/...`),
  compact density, a plain scratch folder as the project (the worktree sandbox refuses
  git outside the worktree; the card's git group is not what is under test), one Sonnet
  5.5 medium thread with two answers of ten numbered paragraphs. With the card open,
  CGEvent scroll gestures over the card (phases began, changed, ended, then a momentum
  tail) scrolled the conversation to its top and back to the middle, and six line
  notches (a mouse) scrolled it up. The newly exposed edges were painted every time,
  "Jump to bottom" showed, and the card stayed put. Dark and light screenshots are in
  the PR body. The card toggle was put back off, as it was found, before quitting (the
  isolated app shares the installed app's WebKit storage); the home and folder were
  removed.

## Daemon restart

Not needed: GUI only.
