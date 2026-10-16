# Theme engine 6: Petros Dusk

A coworker's own Ghostty theme (Peter Bybel, shared 2026-10-16) added as a named dark theme
through the same pipeline as the curated set (`docs/notes/theme-engine-2-engine.md`). The
22nd theme, last on the dark list.

## Source

`gui/frontend/themes/ghostty/Petros Dusk` is hand-written from the shared palette (not an
iTerm2-Color-Schemes file, so `pnpm run themes -- --refresh` never touches it): background
`#301b42`, foreground `#eb9b1a`, the 16 ANSI slots as given, no cursor or selection keys.
Dark by the lightness cut (OKLab L 0.27).

## Derivation and overrides

| variable | value | why |
| --- | --- | --- |
| `--foreground` | `#ee9e20` | Ghostty's `#eb9b1a` is 6.8:1 on the purple; the 7:1 body-text guard lifts it one notch |
| `--primary` | `#eb9b1a` | accent override: the foreground orange is the theme's signature, so New thread, primary buttons and the user bubble carry it; `primary-foreground` is the pane |
| `--destructive` | `#ff4540` | bright red `#eb2d2d` (3.6:1) lifted by the status guard |
| `--info` / `--link` | `#34a4eb` | override `info: 14` (bright aqua). The palette's blue slots are navy (`#2d3f91` 1.6:1, `#33489c` 1.9:1) and the guard would wash them into lavender |
| `--warning` | `#f2a4db` | override `warning: 13` (fuchsia). The natural slot, bright yellow `#fca503`, is the body text colour, so "Asked a question" rows and the Needs login alert read as plain text. Alex chose fuchsia after seeing both; it shares the colour with `--highlight` (ANSI 5 is the same pink), which only the thread's inline marks use |
| `--success` | `#47d422` | bright green, unguarded |
| `--syn-com` | `#bb7e40` | ANSI 8 `#626880` is 2.8:1, so comments fall back to muted-foreground |

No cursor or selection in the file: the cursor is the foreground, the selection is the
guarded 20% foreground mix `#503547`.

## Tests

- `src/themes/contrast.test.ts` counts 22 themes; `internal/store/settings/schema_test.go`'s
  dark-id list ends with `petros-dusk`; `src/stores/themePicker.test.ts` expects 15 dark themes.

## Verified

- `make check` green; `pnpm run themes` twice, no diff.
- `make gui-e2e` for `e2e/themes.spec.ts` (WebKit + Chromium).
- Screenshots (mock harness, WebKit, 1440×900) in the PR body: the picker with Petros Dusk
  applied, and the gallery cards.
- Daemon restart needed after merge: `internal/theme/catalog.json` (go:embed) is what
  `theme.set-dark` validates against, so the old daemon rejects `petros-dusk`.

## Gotchas

- `go test` in a fresh worktree: copied `third_party/ghostty-vt` from the main checkout and
  rewrote `prefix=` in `share/pkgconfig/libghostty-vt-static.pc`; the Go build cache still
  held the other worktree's `.a` path until `go clean -cache`.
