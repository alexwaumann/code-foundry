# Phase 4: the page library (2026-10-26)

A page the model shows with `view.inline` can now be a real single-page React app built
from the app's own components, with no build step, or a free-styled mockup of another
product. Plain HTML pages are unchanged.

## What ships

- **`internal/pagelib`** embeds `dist/` and gives the pages listener one route per file
  (`newPageRoutes` in `internal/daemon/pages.go`: a route map, the most specific route
  wins, so the files sit beside the theme's `/cf/` prefix and `/cf/bridge.js`). `.js` is
  `text/javascript; charset=utf-8`, `.css` is `text/css; charset=utf-8`. Every file is
  `Cache-Control: no-cache` with an ETag of its hash (a 304 on reload), `nosniff` and any
  origin, like the bridge. Only `.js` and `.css` are served (`ui-exports.json` is not).
  The API listener 404s all of them, as it does every page path.
- **Files** (import map specifier → file):

  | Specifier | File | What |
  |---|---|---|
  | `react` | `/cf/react.js` | React 19.3, the app's own |
  | `react-dom` | `/cf/react-dom.js` | `createPortal`, `flushSync`, … |
  | `react-dom/client` | `/cf/react-dom-client.js` | `createRoot` |
  | `react/jsx-runtime` | `/cf/jsx-runtime.js` | what the loader's JSX compiles to |
  | `@cf/ui` | `/cf/ui.js` (+ `/cf/ui.css`) | every `components/ui` component, `cn`, sonner's `toast` |
  | `@cf/icons` | `/cf/icons.js` | all of lucide-react |

  Plus `/cf/jsx.js` (the loader) and `/cf/tailwind.js` (the Tailwind v4 browser runtime).
- **`/cf/jsx.js`** is a classic script, not a module, so it runs before any module loads
  and can still add an import map (WebKit refuses one after the first module fetch). It
  installs the map above unless the page has one (then it warns in the console), then on
  DOMContentLoaded transforms every `text/tsx`, `text/jsx` and `text/babel` script (inline
  or `src=`) with Sucrase (`jsx` with the automatic runtime + `typescript`, production,
  ES syntax kept) and imports each as a blob module, awaiting each before the next
  (document order). Relative and root-relative specifiers are made absolute first: a blob
  URL has no base. `<html data-cf-jsx>` is `running`, then `ready` or `error`.
- **Errors are never silent.** A transform error (with the line and a caret), a failed
  import (a name `@cf/ui` does not export), an evaluation error and any later uncaught
  error or unhandled rejection go to `console.error` and into one box at the top of the
  body. In the flow, not fixed: the bridge sizes the card to the body, so a fixed box
  could sit outside a short card. `ResizeObserver loop` noise is skipped.
- **`/cf/ui.css`** is Tailwind compiled from `src/pagelib/ui.css`. It carries the classes
  the components use (`@source "../components/ui"`), the app's `@theme inline` block, its
  type roles and its `cf-*` keyframes, and a page base: borders take `--cf-border`, there
  are no overflow or user-select rules, and `--cf-zoom: 1`, which DialogContent's offset
  divides by. It also has a safelist of everyday utilities (`src/pagelib/theme.ts`:
  every cf colour for bg/text/border plus hover, fill/stroke, type roles, radius,
  flex/grid, gap/padding/margin steps, sizes and min/max sizes, …) so a React page's own layout works
  without the runtime. The variables come from `/cf/theme.css`; ui.css declares none
  of the theme's.
- **The theme comes from `index.css` itself.** `appTheme()` cuts the `@theme inline` block,
  the `@utility text-*` roles (except the sidebar's `text-brand`) and the `@keyframes cf-*`
  out of `index.css` at build time. A Vite load hook fills the `cf:app-theme` and
  `cf:safelist` markers in `src/pagelib/ui.css` before @tailwindcss/vite compiles it. Nothing
  is copied, so a new slot or role reaches pages on the next `make pagelib`.
  `index.css` was not split: five tests and `themes/convert.ts` read it whole.
- **`/cf/tailwind.js`** is a prelude plus `@tailwindcss/browser` 4.3.3 as published. The
  prelude prepends a `<style type="text/tailwindcss" data-cf-theme>` holding `@import
  "tailwindcss"` and the same app theme. The runtime then builds any utility in the page
  with the app's tokens, arbitrary values included. A page's own
  `<style type="text/tailwindcss">` adds `@theme` colours and rules but must not `@import`:
  the runtime prepends `@import "tailwindcss"` only when no style has one, and ours does.
- **`dark:`** stays Tailwind's `prefers-color-scheme` variant (the app's is `.dark`-scoped).
  A frame's preferred scheme is the app's, so it follows theme switches.
- **Components**: `ui.ts` re-exports every `components/ui/*.tsx` unchanged, plus `cn` and
  `toast`. The library build aliases `@/lib/zoom` to `src/pagelib/zoom.ts`, because the
  real one reads the app store and the Wails runtime and a frame has no zoom. Added to the app's
  folder because pages need them: shadcn `Table` and `Card` (type roles instead of
  `text-sm`, the radius scale), and `DialogTrigger`, `DialogHeader`, `DialogFooter` on
  Dialog. Models reach for those shadcn names first, and an import of a missing name is
  an error box.
- **What does not leave the frame**: Dialog, Popover, menus and sonner's `Toaster` all
  render inside the page's card, never over the app. A dialog in a short card is cut off,
  so the skill says to give the root `min-h-[420px]`. Tooltips need a `<TooltipProvider>`
  (the app has one at its root; a page must add its own). `Tip` works under it.
- **view.inline warnings** (`commands_view_inline.go`):
  - The "lacks /cf/theme.css" warning fires only for an app page: one that calls `cf.*`,
    imports `@cf/ui`, links `/cf/ui.css` or reads `var(--cf-…)`. A page that loads
    `/cf/bridge.js` only so its card fits its height is a mockup, not an app page. This
    widens the brief's "loads bridge.js or @cf/ui": the skill tells mockups to keep the
    bridge for sizing, and they should not be told to link the theme.
  - New: `WarnNoJSXLoader` (TSX, JSX or babel scripts, or a bare `react`/`@cf/*` import
    without `/cf/jsx.js` or a page import map), `WarnNoUICSS` (`@cf/ui` without
    `ui.css`) and `WarnCDN` (React, Babel or Tailwind from a URL).
- **Capabilities**: `--group rendering` gains `react pages`, one line per specifier
  (generated from `pagelib.ImportMap`), and `/cf/jsx.js`, `/cf/ui.css` and
  `/cf/tailwind.js`. The `view.inline` sentence names the new warnings.
- **Pages skill**: `SKILL.md` has both shapes, each with a skeleton: plain HTML for
  something small, and React with `@cf/ui` for state, dialogs, tabs or tables, with the
  exact link, script and import lines. It also has the mockup rule (both stylesheets out,
  bridge in). New references:
  - `react.md`: the loader's rules, the bridge in React (`useEffect` returns what `cf.on`
    returns), overlays, a full archive board and a mockup skeleton.
  - `components.md`: one line per `@cf/ui` export with its props.
  - `verbs.md`: the verbs table, moved out to stay under the 160-line cap.
  `pages_test.go` checks that `components.md` names exactly the built export list
  (`pagelib.UIExports()`, from `dist/ui-exports.json`, which the build writes from
  ui.js's real exports). The entry skill is unchanged.

## Build and committed output

- `gui/frontend/vite.pagelib.config.ts` runs as two library-mode passes (`pnpm run
  pagelib`, i.e. `make pagelib`, which `make gen` runs):
  - `modules`: ES; entries react, react-dom, react-dom-client, jsx-runtime (virtual
    entries whose export lists are read from the packages), ui and icons. Shared code goes
    to `chunks/<hash>.js`, so every entry and a page's `import "react"` load the same
    instance whatever the import map says.
  - `scripts`: an IIFE `jsx.js`, plus `tailwind.js` emitted as an asset.
- Minified (`output.minify`; Vite's lib mode leaves ES output unminified otherwise). No
  sourcemaps: they would double the committed bytes for files nobody steps through.
  Errors carry the page's own `sourceURL`.
- The build is deterministic (two rebuilds give the same hashes). `make check` runs
  `pagelib-check`, which rebuilds and fails when `internal/pagelib/dist` differs from what
  git has (tracked diff or untracked files; staged counts). `make build` stays Go-only:
  it embeds what is committed.
- `.gitattributes` marks `dist/**` `linguist-generated -diff`, so reviews and `git diff`
  stay readable.
- React, lucide, Tailwind, Sucrase and the components are pinned by `package.json`. Any
  upgrade or component change needs `make pagelib`, or check fails.

## Sizes (bytes; gzip -9 in brackets)

| File | Size |
|---|---|
| react.js | 1,721 (718) |
| react-dom.js | 744 (385) |
| react-dom-client.js | 208,061 (64,253) |
| jsx-runtime.js | 122 (128) |
| ui.js | 321,201 (84,116) |
| ui.css | 109,111 (16,871) |
| icons.js | 749,312 (182,187) |
| jsx.js | 204,761 (46,901) |
| tailwind.js | 291,524 (75,598) |
| chunks/ (5 files) | 18,266 |

About 1.9 MB is embedded in the daemon. It is served uncompressed over loopback. A React
page with `@cf/ui` loads about 860 KB, plus 750 KB for icons. Revalidation keeps reloads cheap.

## Gotchas

- An import map can be added from a classic script but not from a module. jsx.js must stay
  an IIFE in `<head>`, before any `<script type="module">`.
- `ui.css` must compile without its markers filled: the app's own Vite (vitest) also
  transforms it when a test imports `ui.ts`. So the base uses plain declarations, not
  `@apply` of the cf utilities.
- The Vite IIFE `name` becomes a global `var`, which reset the loader's double-load guard.
  The guard is `window.__cfJsx` and the IIFE is named `__cfJsxModule`.
- Minified output writes the import map's keys bare and the file names in backticks, so the
  Go test matches either.
- In e2e, a streaming turn keeps the thread pinned to the bottom, so a tall page card high
  up scrolls out of reach. The scripted `pagelib` state puts the board last.

## Verification

- Go: `internal/pagelib` (served set, content types, ETag/304, HEAD, 405, 404),
  `internal/daemon` (the real route map: every file on the pages listener, 404 on the API
  listener), view.inline warning rows, the rendering capability lines, the skill and
  reference checks.
- vitest: `src/pagelib/ui.test.ts` (every `components/ui` file's exports re-exported
  unchanged, `cn` and `toast`, the extracted theme and safelist).
- Playwright (WebKit): `e2e/page-library.spec.ts`, 4 tests, plus bridge, inline-html and
  file-tabs (41 passed together):
  - the board renders Tabs, a Table filled from `cf.on("thread-list")`, a Dialog and an
    icon, and a theme switch repaints it;
  - the Tailwind runtime builds `w-[217px]`, `p-[13px]`, `rounded-pane`, `bg-cf-accent`, the
    `text-heading` role and the page's own `bg-brand`;
  - a TSX syntax error shows the box with the line;
  - a mockup without theme.css renders its own background, React and an icon.

## Live, in the built app (isolated home, Sonnet 5.5 medium, from the skill alone)

The pages listener in the built daemon serves every file with the right type. A wrong path
is 404 and an `If-None-Match` revalidation is 304.

Round 1 found two gaps:

- **"make me a board of my threads I can archive from"** loaded the pages skill but wrote
  plain HTML: the skill offered plain HTML for "a list", and a board with buttons read as
  one. It also guessed `--cf-fg` and `--cf-danger`.
- **"mock up the dashboard of an invented habit-tracking app …"** loaded no skill at all. It
  wrote `~/tendril-mockup/dashboard.html` outside `$CODE_FOUNDRY_PAGES`, hand-posted
  `cf:resize` after view.inline's warning, and rendered free-styled. This is a routing gap.

Fixes:

- Plain HTML is now "only for something tiny and static (one figure, a chart, a short
  form)". React with `@cf/ui` is "the rest: a board, a list with actions, a dashboard,
  anything with state, filters, dialogs, tabs or tables". Rule 3 says "React unless it is
  tiny", and the skill says to read `components.md` and `react.md` first.
- The entry skill's description gains "a mockup" (it stays under 400 characters: "change
  the app's colours" became "recolour the app", "its version" became "version"), and its
  page row gains "mockup of a product". No lines were added.

Round 2, fresh threads:

- **Board**: the skill, then `components.md` and `react.md` read, then a React page:
  `theme.css`, `ui.css`, `bridge.js` and `jsx.js`, then `text/tsx` with
  `Card`/`Badge`/`Checkbox`/`Button`/`Tip` in a `TooltipProvider` and `Archive` from
  `@cf/icons`. It shows status columns with a checkbox and an archive icon per thread and
  an "Archive N" button. It subscribes with `useEffect(() => cf.on("thread-list", …,
  onError), [])`. Archiving is `cf.run("thread.archive", {ids})` from the click, with no
  `confirm()` (the app's dialog asks) and declines handled. view.inline printed no warnings.
  One class, `min-w-64`, was not in ui.css; the safelist now carries min/max sizes on the
  spacing scale.
- **Mockup**: the entry skill, then the pages skill. It wrote `tend-dashboard.html` in its
  pages folder: its own cream and forest-green palette and fonts, with no `theme.css`, no
  `ui.css` and no `@cf/ui`. `/cf/bridge.js` sizes the card. It rendered, with no warnings.
  It is plain HTML with its own JS, which the skill allows for a mockup.
