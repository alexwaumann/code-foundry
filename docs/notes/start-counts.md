# Start page counts: only non-zero

> **Superseded (2026-10-30):** the start page is gone; the window opens on the No project
> composer. See `remove-dashboard.md`.

The fleet line under the greeting ("N connected · N running · N waiting on you") used to always
print all three. With projects but no threads it read "0 connected · 0 running · 0 waiting on you".
Now each segment renders only when its count is above zero, and the line is omitted when all
three are zero. "waiting on you" keeps its amber tint; it only appears when positive.

Playwright expectations in `gui/frontend/e2e/start.spec.ts` updated accordingly.
Screenshots (isolated home, one project, no threads): `start-counts/dark.png`, `start-counts/light.png`.
