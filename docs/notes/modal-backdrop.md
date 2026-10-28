# Modal backdrop: one shared 1px blur + dim (2026-10-27)

PR 1 of the global-modals series (2 and 3 turn Settings and Usage into centred sheets). The
dialog overlay was a flat `bg-black/40` with no blur. On dark themes you could barely see
it, so a modal did not look like it sat above the app. A user noticed. Frontend only.

## What changed

- **A new slot, `--cf-scrim`** (surfaces group): black at 50% alpha on dark themes and 30%
  on light (`#00000080` / `#0000004d`). It comes from the theme's scheme in `slots.ts`
  (`withAlpha(BLACK, by(c, 0.5, 0.3))`), like every other scheme-dependent value. So the
  colour is set in one place. A theme can override it (`#rrggbbaa`), and pages get it in
  `/cf/theme.css`. A slot, not a plain `:root` / `.dark` variable in index.css, because
  `components/ui/dialog.tsx` also ships to pages as `@cf/ui`. Pages read only the published
  slots, so a variable defined only in index.css would leave a page's dialog without a
  scrim. `--color-cf-scrim` in `@theme inline` gives the `bg-cf-scrim` utility.
- **DialogOverlay** is `bg-cf-scrim backdrop-blur-[1px]` plus the existing
  `fade-in-0` / `fade-out-0`. Every DialogContent user gets it: the palette, help, confirm,
  add project, update, snooze, actions, plugins, publish, save theme and save workspace.
- **Only the opacity animates.** The blur radius is fixed at 1px and never transitions.
  Animating `backdrop-filter` over the terminal canvas and page iframes stutters in
  WebKit. A fade of the overlay's opacity also fades how strongly the blur shows, which is
  enough.
- **Overrides still win.** `cn` (tailwind-merge) treats `bg-cf-scrim` and a later
  `bg-black/80` as the same group, so the attachment lightbox's
  `overlayClassName="bg-black/80"` replaces the dim and keeps the blur.
- **Left alone:** the inline HTML page modal (`InlineHtml.tsx`, `bg-black/55`) is scoped to
  its pane, not the app. The Themes page's `DialogCard` is an inline preview, not a modal.

## Values

Alex saw HTML sketches with real-screenshot backgrounds and settled on 1px of blur. He
turned down anything heavier (2, 3 and 5px were tried). The dim is about half on dark and
about a third on light. The sketch used 55% and a tinted 35%; plain black at 50/30 is
close and simpler.

## Ripple of a new slot

- 71 → 72 `--cf-*` slots: `src/themes/slots.test.ts` and `src/design/slots.test.ts`
  count them. docs/THEMES.md has the count, the alpha-slot list and the live-slot list.
- `slotUses.ts` needs an entry (the Themes editor's "Used by").
- `pnpm run themes` regenerates `internal/theme/frame-defaults.json`. `make pagelib`
  rebuilds `internal/pagelib/dist`: ui.css grows about 3 KB because the page safelist
  includes every `cf-*` colour utility.
- The palette guard's allowlist entry for `bg-black/40` in dialog.tsx is gone (no longer
  used, and the guard fails on stale entries). The design guard also rejects a comment
  that puts a slot name next to a colour word, so the comment in dialog.tsx says "a 50%
  dim" and not the colour.

## Tests

- `e2e/modal-backdrop.spec.ts`: in dark and light, the palette and then help have one
  overlay, computed `backdrop-filter: blur(1px)` and `rgba(0, 0, 0, 0.5…)` /
  `rgba(0, 0, 0, 0.3…)`, and both are the same.
- `slots.test.ts` checks the slot's value in each scheme.

## Gotchas

- **Headless WebKit (Playwright) does not paint `backdrop-filter`.** It computes it (the
  e2e assertion passes), but screenshots from the mock app show the dim and no blur. Only
  the real Wails window shows the blur, so the PR's blur screenshot comes from an isolated
  real app (`CODE_FOUNDRY_HOME=/tmp/...`, a scratch project with a terminal of text behind
  `ui.palette.open`, `screencapture -l <window id>`). The shots are on the
  `cf/modal-backdrop-shots` branch, not in the repo (notes are text only).
- The overlay's opacity is animated, so read its computed colour only after
  `toHaveCSS("opacity", "1")`.
