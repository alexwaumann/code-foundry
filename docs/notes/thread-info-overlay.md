# Thread info overlay

Status: done on branch `cf/thread-info-overlay` (one PR, GUI only). Before it, the thread
info card (docs/notes/thread-info-card.md) simply stepped aside while the conversation
beside it would be under 480px (`cardFits`: a 900px window, or 1280px with the side panel
open); the toggle stayed pressed and said "Not enough room". Now the toggle floats the card
over the conversation there.

## Decisions

* **Two states.** `threadInfoOpen` (ui store, persisted) stays the preference for the inline
  card. The overlay is transient: `useCardRoom.overlayFor` (`stores/threadInfoOverlay.ts`),
  the thread whose card floats, never saved. It lives apart from `stores/threadInfo` because
  `keys/bindings` and `stores/views` toggle it, and the card's store imports the composer's
  (a component test that mocks `api/threads` broke on the chain).
* **Toggle** (`toggleThreadInfo`, the binding, the CLI's ShowView and the button alike): with
  room it flips `threadInfoOpen`; without, it shows or hides the selected thread's overlay,
  turning `threadInfoOpen` on when it shows. The sidebar's linked PRs tag calls
  `showThreadInfo(id)`: the overlay too when the pane is already narrow.
* **Pressed** = the inline card shows, or the overlay shows. Going narrow with the card on
  hides it and the overlay does not appear by itself, so the toggle reads unpressed though
  the preference is on (no third look). The "Not enough room" tooltip is gone; the toggle
  keeps the command's title.
* **Box**: `ThreadInfoContent` (the groups) is shared; the inline column wraps it in its
  `aside`, the overlay in an absolute `section` at `top-3 right-3` of the thread body (the
  inline card's 12px gap), `w-77` (308px: the inline card's box, its column being 320 with
  the gutter), `max-h` the body less both gaps, scrolling, `rounded-lg border bg-cf-sidebar
  shadow-lg`, `z-30`: over the conversation, the catching-up pill and jump-to-bottom, under
  the page lightbox (`z-40`) and every portalled layer (menus, hover cards, dialogs, toasts
  at `z-50` on `body`). The conversation does not reflow.
* **Dismiss** (overlay only, `threadInfoOpen` untouched): Escape, unless focus is in a text
  field or a menu, list or dialog; a press outside it or the toggle; another thread (unless
  the overlay was shown for that one, the PR tag's case); room again; leaving the thread
  body (a subagent view, Ember, another page).
* **Focus**: a non-modal region labelled "Thread info" (`tabIndex -1`). Opened from a key
  (the chord, the palette's Enter) it takes focus; from a click it does not
  (`lib/inputModality`: the last input, tracked ahead of the key handler). Escape gives
  focus to the toggle.

## Rebased onto the laid-over card (thread-info-scroll)

`docs/notes/thread-info-scroll.md` (PR #420) made the inline card an absolute column over
the body's right, with `--ti-inset` keeping the list, dock and chips clear of it and a
wheel over a short card handed to the conversation (`scrollerRef`). The overlay keeps its
own box and does not take part in either:

* **No inset.** ThreadPane sets `--ti-inset` only while the inline card shows
  (`infoOpen && infoFits`); with the overlay the body's inset is `0px`, so the
  conversation, the dock and "Jump to bottom" keep the full width and do not reflow.
* **Wheel.** The overlay renders `ThreadInfoContent`, not `ThreadInfoCard`, so it has no
  forwarding: a wheel over it scrolls its own content (it is a floating surface the
  reader is looking at, not part of the conversation's column); a wheel anywhere else
  scrolls the list as usual.
* **Scrollbar.** The list's scrollbar is at the pane's edge in a 12px gutter; the
  overlay's `right-3` leaves it visible and usable to the overlay's right.
* `paneBox` (the Cite layer's clamp) measures the inline card only; the overlay is a
  transient layer above the conversation and does not narrow it.

## Gotchas

* "Inside" includes the card's portalled menus and hover cards: the overlay marks a press
  with React's `onPointerDownCapture` (React events follow the component tree through
  portals) and the document listener, in the bubble phase, reads the mark afterwards.
* While a Radix modal menu is up `body` has `pointer-events: none`; a press then closes the
  menu only.
* Escape is caught in the capture phase, ahead of a menu's own listener: after it the menu
  would already be closing, and a focus check could not tell it was open.

## Tests

* `stores/threadInfoOverlay.test.ts`: toggle with and without room, card already on, dismiss
  keeps `threadInfoOpen`, room again clears the overlay, `showThreadInfo`.
* `e2e/thread-info.spec.ts`: the narrow-pane case now opens the overlay (placement, width,
  no reflow, a menu inside and its Escape, a fold keeps it, toggle hides it, widening swaps
  it for the inline card, narrow again does not bring it back); a second case for the chord
  (focus, Escape to the toggle), a press outside, Escape in the prompt, another thread.

## Verified

`make check` green; `e2e/thread-info.spec.ts` and the specs that toggle the card green on
WebKit. The built app (`make gui-build`) on an isolated home with a scratch repo and one
Sonnet 5.5 thread: overlay at 900px and at 1280px with the side panel, the project menu
over it, Escape closing the menu only, a press in the conversation hiding it, dark and
light. Screenshots in the PR body.
