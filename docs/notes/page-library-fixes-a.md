# Page library fixes A (2026-10-26)

Library findings from the test round of phase 4 (docs/notes/page-library.md). A parallel
branch takes routing, `thread.label`'s help, Escape from a frame and shrinking cards; this
one does not touch them.

## What changed

- **Roles lose to utilities, as in the app.** `/cf/theme.css` declared the type roles
  unlayered, and an unlayered rule beats every `@layer utilities` rule of ui.css and the
  runtime: `text-body text-cf-error-text` kept the body colour, `font-medium` did nothing,
  Badge and Button text took the role's colour (unreadable Badges, dark-on-blue Buttons in
  light). frame.css now opens with `@layer theme, base, components, utilities;` (Tailwind's
  order, so a layer it opens first keeps its place) and puts the roles in `@layer utilities`.
  theme.css comes first in a page, so ui.css's utilities follow the roles in that layer and
  win, the way the app's `@utility` roles sort ahead of single-property utilities. The
  `:where()` page defaults stay unlayered. A page's own unlayered CSS now beats a role too.
  The app loads index.css, not frame.css, so it is unaffected.
- **Margins.** ui.css's body is a flow root, so a first or last child's margin stays inside
  it. The bridge also measures the margin box of the body's last in-flow child (fixed and
  absolute ones left out: an overlay is the frame's height, and would grow the card by the
  body margin on every pass). With nothing between them, the child's and the body's bottom
  margins collapse to the larger, so a plain page's 8px body margin is not added twice.
- **Runtime borders.** `/cf/tailwind.js`'s prelude ends with a base layer that sets
  `border-color: var(--cf-border, currentColor)` and the placeholder colour again, after the
  runtime's preflight (which resets them after ui.css's in the same layer).
- **Arbitrary values: the scale instead.** ui.css still has none. The advice is now scale
  classes (`min-h-112` is 448px) and the safelist carries `w`, `h`, `min-*`, `max-*` in 4px
  steps up to 160 (about +6 KB). Safelisting `min-h-[420px]` was rejected: models generalise
  one arbitrary value to others (`min-h-[320px]` in the test round), and a scale class
  teaches the rule. view.inline warns when a class attribute (or `cn(` / template string's
  first string) has a `[…]` token and the page does not load `/cf/tailwind.js`. The check
  lives in `commands_view_inline_arbitrary.go` and joins `pageChecks` from an `init()`, so
  the other branch's edits to `commands_view_inline.go` (warning wording) do not conflict.
- **Dialogs scroll.** A page's `DialogContent` gets `max-height: calc(86vh - 0.75rem);
  overflow-y: auto` from ui.css's components layer: it sits 14vh down, so it stops at the
  card's bottom edge and its buttons stay reachable (Radix's scroll lock stops the wheel).
  A `max-h-*` or `overflow-*` utility still wins. Page-only rather than in dialog.tsx: the
  app's dialogs size themselves, and an `overflow: auto` would clip things in them.
- **The loader (`/cf/jsx.js`).**
  - Import specifiers are found with Sucrase's own tokenizer on the compiled code (the
    string after `import`, `from` or `import(`), so a string that reads like an import stays
    as written. The deep parser modules ship no types: `src/pagelib/sucrase-parser.d.ts`
    declares the few names used. jsx.js grew 2 KB (the parser was already in it). Vitest
    inlines sucrase (its ESM imports have no extensions).
  - Sucrase does not check that a closing tag matches: `<b>…</div>` compiles silently, or
    fails at a later line. `tagMismatch` walks the JSX tokens with a stack and reports the
    first closing tag that closes another element, with where that one opened; on a parse
    error it walks the tokens read so far, so it still wins over Sucrase's later message.
  - An inline script's first line in the .html file comes from the page's own HTML,
    fetched once (the first occurrence of the script's text after the previous one). Errors
    and the code frame use file lines. The compiled code is padded with that many blank
    lines (Sucrase keeps line numbers), so stack frames are file lines too, and the
    `sourceURL` is the page's file name. WebKit ignores `sourceURL` in stacks, so blob URLs
    are replaced by that name when an error is shown. If the HTML cannot be read, the title
    says "page.html script 2" with script lines, as before.
  - Errors print the message and the stack. WebKit's stack has no message line, so a render
    that threw used to show only react-dom frames.
- **Popover and Tooltip padding**: components.md says they have none and gives the classes
  (`p-3`; `px-2.5 py-1.5 text-body-sm`, or `Tip`).
- **Light-only and bigger pages.** `/cf/theme.css?scheme=light` (or `dark`) serves the
  published theme when it is that scheme, else that scheme's default, with no media query
  (`Live.PinnedCSS`, mirrored in the mock). The bridge reads the scheme from the theme link
  and, while the app shows the other scheme, leaves the stylesheet's slots alone (it removes
  any it set). The roles in theme.css, ui.css and the runtime theme are in rem (px / 16, at
  generation by `remRole`; the app's index.css stays px), so `<html style="font-size: 18px">`
  scales type with Tailwind's rem spacing. react.md says both, and why not to redeclare
  slots: the component names (`--primary`, `--card`) resolve from the slots on `:root`.
- **Checkbox**: indeterminate (aria-checked mixed) fills like checked and draws lucide's
  minus. A named group (`group/checkbox`) so an outer `.group` cannot hide the tick. The app
  has no indeterminate Checkbox today.
- **examples.md** opens with the PR dashboard in React with `@cf/ui` (Card, Table, Badge,
  Button, per-row state), then a one-figure plain page; the form and token examples stay
  plain HTML.

## Tests

- vitest: `src/pagelib/source.test.ts` (specifiers vs look-alike strings, tag matching,
  file-line frames), `components/ui/checkbox.test.tsx`; frame.test.ts compares the whole
  generated frame.css as before.
- Go: `TestArbitraryClassWarning`/`TestArbitraryClassCheck` (internal test), pinned cases
  in `TestFrameHandler`, the pages skill test's react.md strings.
- Playwright (`e2e/page-library.spec.ts`, mock pages roles, margin, both, throw, mismatch,
  pinned): role + colour/weight utility and Badge/Button text in both schemes; the margin
  card and the error box fit; ui.css + runtime border colour; error locations
  (`mismatch.html` line 14, `broken.html` line 11, `throw.html:12` with no `blob:`); the
  dash; look-alike strings untouched; a light-pinned page stays light through theme
  switches at an 18px root (16.875px body text).

## Gotchas

- An `@layer utilities { … }` alone at the top of frame.css would have made `utilities` the
  first layer declared, so lowest: ui.css's base (preflight) would then beat every utility.
  The order statement first avoids it.
- A page that links ui.css before theme.css gets the old behaviour (the role later in the
  same layer). The skill always says theme.css first.
