# Bundled Nerd Font

The GUI ships JetBrainsMono Nerd Font Mono and uses it as the default terminal font, so Nerd
Font glyphs (powerline, devicons, codicons, ...) render without installing anything.
`appearance.font_family` still overrides it.

Status: `make check` green (53 vitest files / 754 tests). Full Playwright suite 282/282
(WebKit + Chromium), including the new `e2e/font.spec.ts`. `make gui-build` embeds the fonts (the TTF and license bytes are in
`gui/bin/Code Foundry`). Not looked at in the real Wails window.

## What ships

- `gui/frontend/public/fonts/JetBrainsMonoNerdFontMono-{Regular,Bold}.ttf`, unmodified, from
  the official Nerd Fonts release **v3.5.1** (`JetBrainsMono.tar.xz`, sha256 in the folder's
  README; JetBrains Mono 2.304).
- `OFL.txt` (from the archive) and `NERD-FONTS-LICENSE.md` (repo LICENSE at tag v3.5.1). The
  archive has no Nerd Fonts LICENSE of its own. Both sit next to the fonts, so they ship in the
  binary too, which the OFL asks of redistributions.
- Family name inside the TTFs (fc-scan, name ID 16): `JetBrainsMono Nerd Font Mono` (ID 1 is
  `JetBrainsMono NFM`). That exact string is in `index.css` and `src/terminal/fonts.ts`.

## Decisions

- **Mono variant.** Icons in `Nerd Font Mono` are one cell wide. The unsuffixed `Nerd Font`
  has ~1.5-2 cell icons that overflow into the next cell in a fixed grid; `Propo` is
  proportional. A terminal needs Mono.
- **Two weights.** xterm draws normal text at 400 and bold at `fontWeightBold` (700) and
  synthesizes italic, so Regular + Bold cover everything it renders. Each face is ~2.5 MB.
- **TTF, not WOFF2.** No woff2/fonttools tooling here, and the files are served from memory
  out of the binary, so transfer size does not matter; only binary size does. WOFF2 would
  roughly halve the 5 MB.
- **`public/`, not `src/assets/`.** Stable unhashed URLs (`/fonts/...`) that `fonts.ts` and
  the e2e can name, and the license and README files are copied into `dist/` alongside the
  fonts. Cache-busting hashes buy nothing for an embedded asset server.
- **Size.** `gui/bin/Code Foundry` went from 15,926,962 to 21,128,242 bytes (+5,201,280,
  about +5.0 MiB / +33%); the TTFs are 5,150,264 bytes. Wails embeds assets uncompressed.
- **One default stack.** `src/terminal/fonts.ts` owns `BUNDLED_FONT_FAMILY`, `FONT_FALLBACKS`
  and `DEFAULT_TERMINAL_FONT_FAMILY` (`"JetBrainsMono Nerd Font Mono", "JetBrains Mono", "SF
  Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace`); `xterm.ts` and
  `stores/settings.ts` import them (the old copies in `theme.ts` and `settings.ts` are gone).
- **The Go default had to change too.** The daemon's snapshot carries each setting's
  effective value, so an unset `appearance.font_family` arrives as the schema default, not
  empty, and the frontend default only applies against a daemon without settings. The Go
  default is now `JetBrainsMono Nerd Font Mono, JetBrains Mono, SF Mono, Menlo`, and the
  description says the font ships with the app. It duplicates the frontend's first names;
  that duplication was already there.
- **Only the terminal.** The `ui-monospace` rules for non-terminal mono text in `index.css`
  are unchanged.

## Gotchas

- **Font-load race.** xterm measures cell metrics on `open()` (and on a `fontFamily` /
  `fontSize` option change), and the WebGL addon rasterizes glyphs into an atlas from those
  metrics. A terminal that opens before the web font loads measures the fallback and keeps
  that grid. Two guards:
  1. `main.tsx` renders the app only after `loadBundledFont()` resolves: `document.fonts.load`
     for 400 and 700, raced against a 1 s timeout. It never rejects, and resolves at once
     where the FontFaceSet API is missing (jsdom), so a failure cannot block the UI.
  2. Mounted `XtermRenderer`s subscribe to `onBundledFontLoaded` (FontFaceSet `loadingdone`
     filtered to the bundled family) and call `refreshFontMetrics()`. xterm has no public
     re-measure, and setting an option to its current value fires nothing, so it sets
     `fontFamily` to `<family>, monospace` and back (each change re-measures and rebuilds the
     WebGL atlas), then `clearTextureAtlas()` (an atlas shared with another terminal on the
     same config could otherwise come back with fallback glyphs), then `fit()`. Checked by
     hand in WebKit and Chromium with a face served 1.5 s late: cell height 15 -> 17 px
     after the refresh.
- **No `local()` in the @font-face.** With `local()` first and the font installed (as on
  Alex's machine), WebKit resolved the face to the installed font, and WebKit canvas text
  ignores such a face: `measureText` fell back to the next family (Menlo), DOM text did not.
  xterm measures with a canvas and the WebGL addon draws glyphs with one, so the terminal
  silently stayed on Menlo. `url()`-only faces work in canvas in both engines. The same
  WebKit rule means a user-installed font named in `appearance.font_family` may not reach the
  terminal either (in Playwright's WebKit, `"JetBrainsMono NFM"` fell back the same way;
  WKWebView in the real app not checked). `e2e/font.spec.ts` guards this by checking the
  canvas line box of the bundled family (1.32 em; Menlo and serif are ~1.16 em).
- A settings file that already sets `font_family` keeps winning. Alex's
  `~/.code-foundry/settings.toml` has `font_family = "JetBrainsMono NF, SF Mono, Menlo"` (the
  double-width variant); delete that line to get the bundled Mono default.
- A late font load while the terminal is hidden (`display: none`) re-measures 0x0, which xterm
  ignores, so the stale metrics stay until the next font change. Only reachable if the 1 s
  startup timeout lapsed.
