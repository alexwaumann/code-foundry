# Page frames under the app's zoom (2026-11-04)

A user below 100% zoom saw a white strip down the right of every page a thread shows.

## Cause

The zoom is CSS `zoom` on `<html>` (lib/zoom.ts). The system WKWebView applies it to a frame's
document a second time: at 90% the document fills 90% of the frame and the rest is an opaque
white canvas; at 110% or more it is wider than the frame and its right edge is cut off.
Playwright's WebKit does neither, so e2e cannot see this. Reproduced with a small Swift
WKWebView host loading the app from `make drive`.

## Decisions

- `HtmlFrame`'s iframe undoes the zoom on itself (`zoom: calc(1 / var(--cf-zoom))`), as the
  terminal host does. One change covers the card, the lightbox and the File tab.
- A page stays at 100% under the app's zoom. Following it is a separate change.
- A `cf:resize` height is the page's own px, so the frame divides it by the zoom for the box.
  A zoom change keeps the last asked height until the page asks again.

## Gotcha

The rule must be there before the frame loads: adding it to a loaded frame fixes the measured
width and leaves the strip. As a class it always is, and changing the zoom with a page open
stays clean.
