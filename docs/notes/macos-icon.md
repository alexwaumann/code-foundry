# macOS app icon: molten core

Replaces the painted crucible app icon with a generated "molten core" render: a glowing
vortex behind a glass bezel in a dark runic frame. The painting stays in the app as the
updater dialog's artwork (`gui/frontend/public/appicon.png`, untouched).

## Decisions

* **Why not a Liquid Glass `.icon`.** macOS 26/27 render layered Icon Composer icons
  (glass, dark/clear/tinted variants) only for bundles with `Assets.car` and
  `CFBundleIconName`. We ship a bare executable (MDM blocks unsigned bundles), so the
  Dock shows whatever PNG `gui/icon.go` hands to `NSApp.applicationIconImage`, as-is.
  The render carries its own glass bezel instead, and one image serves light and dark
  mode, so no appearance-swap code was needed.
* **How it was chosen.** HTML sketches (kept out of the repo) compared flat vector
  glyphs, a molten-conduit series from detailed to minimal, crops of the painting, glass
  "foundry core" glyphs, and several generated renders in Dock and ⌘-Tab mockups. A
  variant with stone "CF" letters over the core was dropped: it read in ⌘-Tab at 112 px
  but turned into a grey smudge at 32 px and below, and the letters covered the bright
  centre that makes the icon readable at every size.
* **Crop.** The whole render. The frame reads from 64 px up; trimming to the inner
  window lost the frame for little gain.
* **Assets.** `appicon.icon/Assets/core-art.png` (1024px) replaces `logo-art.png` as the
  source of truth; `docs/brand/README.md` has the regeneration script.

## Gotchas

* **The About panel shows a folder, not the icon** (true before this change too). The
  app menu's About item is AppKit's `orderFrontStandardAboutPanel:`, which takes the
  icon from the executable's location in Finder, not from `applicationIconImage`. The
  claim in `docs/notes/bare-binary-distribution.md` that the About panel picks up the
  runtime icon is wrong. Fix (follow-up): call
  `orderFrontStandardAboutPanelWithOptions:` with `NSAboutPanelOptionApplicationIcon`.
* `wails3 generate icons -iconcomposerinput` silently skips `Assets.car` without a full
  Xcode (`actool`); nothing ships it anyway.

## Verification

`make check` green (Go + 2195 frontend tests), `make gui-build` built, the built app run
from an isolated `CODE_FOUNDRY_HOME`; Alex confirmed the new icon in the Dock and in
⌘-Tab.
