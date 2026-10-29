# Thread dock height after a thread switch

Two users reported (2026-10-28) that a finished answer's last lines sat under the composer and
the list would not scroll past them; one also saw the Jump to bottom chip drawn under the
composer. Both come from one number: the timeline's `bottomInset`, the composer dock's height,
which pads the list's end (`paddingEnd`) and places the chip (`bottom: dockHeight - 20`).

## Cause

`useElementHeight` took a ref object and set up its ResizeObserver once, in a layout effect keyed
on the ref. PR #379 (2026-10-27, in v0.20.3) wrapped the thread body in `PaneOverlay`, keyed by
thread, so a switch to another thread remounts the dock. The observer stayed on the first dock,
now detached, and reported it at 0; the state kept 0 for every thread shown after the first
switch. Hence the first thread of a session looked right and everything after a switch did not.
The e2e suite never switched threads after streaming a long answer, so nothing caught it.

## Fix

The hook is a callback ref: attaching observes the new element, detaching disconnects. Same
three callers (content pane, Ember, inline panel view). `e2e/thread-dock-height.spec.ts` streams
a long answer, switches away and back, and checks the last row clears the composer and the chip
sits `dockHeight - 20` above the bottom. It fails on the old hook.
