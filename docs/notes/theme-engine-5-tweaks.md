# Theme engine 5: GitHub defaults, Latte lavender, Dawn red, the select chevron

A follow-up to the four theme-engine PRs (notes `theme-engine-{1..4}-*.md`). Four items,
one PR: the default themes become GitHub Dark / GitHub Light, Catppuccin Latte's primary
becomes lavender, Rosé Pine Dawn's destructive gets redder, and the phantom scroll chevron
in the Settings light-theme select is looked into.

## Defaults: GitHub Dark and GitHub Light

- `src/themes/defaults.ts`: `DEFAULT_DARK = "github-dark"`, `DEFAULT_LIGHT = "github-light"`.
- `themes/overrides.json`: the catalog follows overrides.json order, and
  `contrast.test.ts` asserts the default comes first in each scheme. `github-dark` moved to
  the top of the dark block and `github-light` to the top of the light block; every other
  entry kept its place (Catppuccin is now second in each). `pnpm run themes` rewrote
  `catalog.json`, `themes.css` and `internal/theme/catalog.json` (its `defaults` and the
  order). Running it twice gives no diff.
- What hard-coded the old defaults and changed with them:
  - `gui/frontend/index.html`'s first-paint script (fallback ids; `lib/firstPaint.test.ts`
    checks they equal the constants);
  - `gui/windowbg.go`'s `defaultWindowBackground` is GitHub Dark's and Light's sheets,
    `#04070c` / `#f0f0f0` (was Mocha `#131222` / Latte `#e0e2e6`). This is the window colour
    before the page paints on a first launch;
  - Go tests: `internal/theme`, `internal/api` (the schema's default and first label),
    `internal/command` (theme.list marks, the "want one of" order), `internal/store/settings`
    (defaults, the "must be one of" lists, which now start with the GitHub id), `gui/windowbg_test.go`;
  - frontend: `lib/theme.test.ts`, `e2e/themes.spec.ts`, `e2e/settings.spec.ts`, and comments
    in `lib/theme.ts`, `themes/index.ts`, `themes/convert.ts`, `index.css`, `internal/theme/theme.go`,
    `internal/store/settings/settings.go`.
  - `stores/themePicker.test.ts` keeps Catppuccin as a fixture (its pairing cases need a pair);
    the constant is renamed `SLOTS` so it no longer reads as the app defaults.
  - `mock/settings.ts` already reads `DEFAULT_DARK` / `DEFAULT_LIGHT`; the settings schema's
    default and labels come from `internal/theme`'s catalog, so Settings shows "GitHub Dark"
    / "GitHub Light" with no further change.
- **Users with no explicit theme switch to GitHub on update.** `settings.toml` stores only
  values that differ from the default, and a missing key is its default, so anyone who never
  picked a theme moves from Catppuccin to GitHub. Intended. Anyone who wants Catppuccin back
  sets it in Settings or the Themes page (`theme set-dark catppuccin-mocha`). No migration: the
  ids are unchanged.

## Catppuccin Latte primary: lavender

`accent` is now the official Latte lavender `#7287fd` (was mauve `#8839ef`). Lavender is too
light to carry text either way (2.8:1 under the pane colour `#eff1f5`, 2.5:1 under the fg
`#4c4f69`), so the primary-text guard darkens it at the same hue (OKLCH h 273, L 0.66 → 0.55)
to **`#5363d5`**, which reaches 4.5:1 under `#eff1f5`. That is the `--primary` the app paints
(New thread, primary buttons, the user bubble tint); `--ring` follows at `#8596e3`. `--syn-kw`
stays mauve (`#8839ef`, guarded `#8433ea`): the keyword colour is a separate decision. Mocha
is unchanged.

## Rosé Pine Dawn destructive: a redder love

Ghostty's love `#b4637a` (OKLCH h 2.7, C 0.107) is 3.8:1 on the pane, and the status guard
darkened it to `#9c4d64`, which reads mauve-pink. The override is a literal
`status.destructive: "#b0405a"` (h 9.4, C 0.147: the hue a notch toward red, a little more
chroma, about the same lightness). It already clears the guard: 5.16:1 on the pane `#faf4ed`,
4.51:1 on the sheet `#ebe5de`. **The final guarded value is `#b0405a`**, unchanged by the guard,
so there was nothing to adjust. `destructive-foreground` stays the pane.

The override table in `theme-engine-2-engine.md` has both changes.

## The phantom chevron in the light-theme select: not reproduced

Report: Settings → Appearance, the Light theme select's list shows Radix's scroll-down
button under its seven items, and it scrolls nothing. Hypothesis: the content's
`max-height: calc(var(--radix-select-content-available-height) / var(--cf-zoom))` leaves the
list a few px short, and Radix renders `ScrollDownButton` for any `scrollHeight >
clientHeight`.

Tried, with no scroll button on the light list in any case:

- **Mock harness, Playwright WebKit**, 1280×800 and 1440×900 at 90/100/125%: the light list
  measures 234px (7 × 32 + padding + border) with `scrollHeight == clientHeight` (232); max-height
  268 to 449px. The dark list overflows for real when it opens upward (456px of items), and
  shows the button as it should.
- **Mock sweep**: the trigger placed at every reachable height of the settings pane in 7px
  steps, at 90, 100, 110 and 150%: no scroll button on the light list at any position.
  Floating-ui flips the list above the trigger as soon as it does not fit below, so it is
  never clamped by a few px.
- **Built app (WKWebView)**, isolated home: 1440×900 at 90/100/110/125%; window heights 540
  to 700 in 20px steps and 562 to 578 in 2px steps (the flip threshold, where the room below
  is closest to the list height); the selected item first, sixth and last (Radix scrolls it
  into view on open); dark and light scheme. The list either fits below or flips above; never a
  chevron. PR #125's Settings screenshot does not show the list open.

So no fix ships: without a repro, any change to the max-height, the collision handling or the
scroll buttons would be a guess, and the dark list's real scroll buttons depend on them.
`select.tsx` is unchanged. If it shows up again, the useful facts are the window size, the
zoom, the scheme, the settings pane's scroll position and the light slot's value; with those,
`e2e` can measure the content's `max-height`, the viewport's `scrollHeight`/`clientHeight`
and `data-side`.

## Gotchas

- **`go test` in a fresh worktree** needs libghostty-vt. `make ghostty-vt` downloads zig, which
  timed out here; the main checkout's `third_party/ghostty-vt` (same `GHOSTTY_COMMIT`) copied
  over, with the `prefix=` line of its `.pc` file rewritten to this worktree, works.
- **zsh modifiers.** `git push origin "$c:refs/heads/…"` is read as `$c` with the `:r`
  modifier; brace it, `"${c}:refs/heads/…"`.
- **Screenshots behind a system dialog.** A macOS permission prompt for another app sat over
  the window; `screencapture -l <CGWindowID>` (the window's id by its owner pid) captures the
  window alone. Clicks went through `CGEvent`s; the scratch daemon was put back to scheme dark
  and the Catppuccin slots before quitting, because the copy shares the installed app's WebKit
  `localStorage` (`cf.theme`).

## Verified

- `make check` green. `pnpm run themes` run twice: no diff.
- `make gui-e2e` for the specs touched: `e2e/themes.spec.ts` and `e2e/settings.spec.ts`,
  42 passed (21 × WebKit and Chromium).
- Live (`make gui-build`, `CODE_FOUNDRY_HOME=/tmp/cf-te5`, 1440×900): a fresh install opens
  in GitHub Dark (blue New thread, `window-background.json` `#04070c` / `#f0f0f0`, the
  settings file lists `# theme_dark = "github-dark"` commented); scheme light shows GitHub
  Light; Catppuccin Latte paints New thread and Add a project in `#5363d5`; the Themes page
  on Rosé Pine Dawn shows the Delete button, the Failed badge, the dialog's Archive and the
  Push failed alert in `#b0405a`; the light select opens with no chevron (dark and light
  scheme), the 14-item dark select fits below its trigger at this height.
- Screenshots: `t3code/theme-engine-5-shots` branch (not merged).
- No daemon restart needed for the frontend, but the daemon's embedded catalog
  (`internal/theme/catalog.json`) carries the defaults the settings schema and `theme.list`
  report, so restart the daemon after the update.
