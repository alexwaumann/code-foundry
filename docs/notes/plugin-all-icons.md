# Plugin icons: all of lucide

Supersedes the icon decision in `plugin-hints-and-inputs.md`: a plugin may name any lucide
icon, not only the ones the app uses.

## Decisions

- `ui.Icons` is every name in lucide's dynamic import map, 2,121 with aliases. Aliases stay
  valid because lucide 1.x keeps older names only as aliases: `trash-2` is now an alias of
  `trash`, and dropping it would have turned existing plugins' icons into circles.
- The list moved from `manifest.md` to `reference/icons.md`. At this size it does not fit
  under the 32 KB file cap beside the manifest reference, and a task only ever searches it.
- `icons.ts` has no table any more: a kebab name becomes lucide's export name, looked up on the
  module namespace. `Icon` and `LucideProvider` are capitalised exports that are not icons.
- `scripts/pluginIcons.ts` writes `pluginsdk/ui/icons.go`; run it after a lucide bump.
  `icons.test.ts` fails while the two differ, which replaces the Go test that read `icons.ts`.

## Cost

The GUI's shared `bindings` chunk grows by 713 KB (1.45 to 2.16 MB, raw); `main` does not change.

## Gotcha

Do not import `lucide-react/dynamicIconImports` in app code: it would add a chunk per icon.
Tests and the script may.
