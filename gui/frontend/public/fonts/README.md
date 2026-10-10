# Bundled terminal font

JetBrainsMono Nerd Font **Mono** (font-family `"JetBrainsMono Nerd Font Mono"`), Regular and
Bold, from the official Nerd Fonts release **v3.5.1** (JetBrains Mono 2.304):

- Archive: https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/JetBrainsMono.tar.xz
  (sha256 `04d5e8f903693f9dd13e16f867e994834e681eb3c72c0d337a770dcda09010cf`)
- `JetBrainsMonoNerdFontMono-Regular.ttf` sha256 `f2a5ea6cfab397445ffab00c0370927b66d61e560a05db5db271b42006381c1a`
- `JetBrainsMonoNerdFontMono-Bold.ttf` sha256 `bfcf9a917276ffc058867d87cbc8a5b2f1ab0f4b710e9170dc02763ccb80bd4b`

Files are unmodified. Licenses:

- `OFL.txt`: SIL Open Font License 1.1 for JetBrains Mono (and the patched fonts), from the
  release archive.
- `NERD-FONTS-LICENSE.md`: the Nerd Fonts repository LICENSE at tag v3.5.1 (OFL for patched
  fonts; MIT for the patcher; icon-set licenses are listed in the upstream license audit).

Declared in `src/index.css` (@font-face) and loaded before the first terminal opens by
`src/terminal/fonts.ts`. See `docs/notes/bundled-nerd-font.md`.
