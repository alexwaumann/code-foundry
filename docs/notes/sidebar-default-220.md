# Sidebar default 220px

- `SIDEBAR_DEFAULT` is now 220 (was 280), equal to `SIDEBAR_MIN`. Double-clicking the resize
  handle restores 220.
- The width already persisted in the `code-foundry.ui` localStorage store. To move every
  existing install to 220 once, the store went to version 4 and its `migrate` drops
  `sidebarWidth` for any store saved at version < 4. zustand writes the store back at version
  4 after that, so the reset happens once; widths dragged afterwards persist (clamped to
  220–520 by `merge`, as before).
- A user who runs an older build again after this one sees zustand's "newer version" path
  (no migrate), which keeps the saved width; no cross-version concern since GUI and daemon
  ship together.
- `migrate` now reads the persisted value through `persistedRecord`, so a non-record never
  reaches the destructure.
- e2e specs that hard-coded the 280px sidebar in layout arithmetic were updated.
