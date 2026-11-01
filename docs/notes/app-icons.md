# Real Finder and editor icons

"Open in Finder" and the thread info card's "Open in" menu show the real Finder and editor
app icons instead of the hand-drawn FinderMark and a generic code glyph.

## Decisions

- **Read at runtime, never shipped.** The icons are trademarked artwork, so nothing of
  theirs is committed: no PNG or ICNS fixtures, no vendored icon set. The daemon reads each
  icon from the bundle installed on the user's Mac. Tests use stub bundles (a fake
  Info.plist and empty .icns files in a temp dir) with an injected plist reader and
  rasteriser; they never shell out.
- **GitOpsService.ListAppIcons** (bundle ids in, `AppIcon{bundle_id, png}` out, 64x64 PNG).
  It lives in the gitops store beside editor detection, which already knows every editor's
  bundle path. Finder (`com.apple.finder`) is a fixed entry at
  `/System/Library/CoreServices/Finder.app`; every other id must be a detected editor, and
  an unknown id is skipped. Asking for Finder alone never runs editor detection.
- **How an icon is read** (`internal/store/gitops/appicon.go`): `plutil -extract
  CFBundleIconFile raw` on the Info.plist, `.icns` added when the name has no extension
  (Finder's is `Finder`, VS Code's `Code.icns`), the file under `Contents/Resources`, then
  `sips -s format png --resampleHeightWidthMax 64` into a temp dir. The result must start
  with the PNG signature and be at most 1 MiB.
- **Missing is not an error.** No `CFBundleIconFile` (an asset-catalog-only app), a name
  that is not a bare file name, a missing file or a failed sips: the id is absent from the
  response, with one debug log line. The caller never sees an error.
- **Cache.** In memory by bundle id, misses included, so an app without an icon does not
  run plutil again. Cleared by `RefreshEditorApps` (the daemon calls it on a settings
  change) and by `EditorApps(refresh)` (`ListEditorApps{refresh}`), so an app updated or
  reinstalled at another path is read again. One mutex covers the reads, so two batches
  asking for the same app rasterise it once. A read gets 10 s and outlives a cancelled
  request (a cancelled one must not cache "no icon").
- **GUI** (`stores/appIcons.ts`, `components/icons/AppIcon.tsx`). `useAppIcon(id)` asks
  once per session; the ids asked for in one tick go out as one request (the card's menu
  asks for Finder and every editor together). A failed request forgets its ids so a later
  mount retries. The data URL is built in `src/api/gitops.ts`.
- **An `<svg>` holding an `<image>`, not an `<img>`.** Every slot an icon lands in (Button,
  DropdownMenuItem, the info card's Row, LinkButton, OverflowMenu, HeaderAction) sizes its
  `svg` children (`[&_svg]:size-…`, some only when the svg has no `size-` class). An `<img>`
  would need each of those selectors extended; an svg gets the same size, shrink and gap as
  the lucide fallback it replaces, so the swap from fallback to icon never moves anything.
  Alone it is 16px (width/height attributes, which any class overrides).
- **Fallbacks.** Finder: lucide `Folder`. Editors: `SquareArrowOutUpRight`. Shown while
  loading and when the daemon has no icon; the e2e mock answers ListAppIcons with nothing,
  so e2e always sees the fallbacks.
- **Devin.** Windsurf was renamed: the `knownEditors` row is `Devin`, bundles `Devin.app`
  then `Windsurf.app`, fallback id `com.exafunction.windsurf` (the plist's id wins when
  readable). The CLI editor name `windsurf` (resolveEditor, `-g file:line`) is unchanged.

## Excluded

- The file header's generic "Open in editor" action keeps its glyph: it opens the
  configured editor command, which is not resolved to a bundle.

## Gotchas

- The real icons carry macOS's transparent margin, so at 14px they read slightly smaller
  than the stroke glyphs beside them. Accepted: cropping would distort apps whose artwork
  fills the canvas.
- A daemon restart is needed after updating: an older daemon answers Unimplemented and the
  GUI keeps showing fallbacks (and retries on the next mount).
