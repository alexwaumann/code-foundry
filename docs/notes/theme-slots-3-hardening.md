# Theme slots 3: hardening (2026-10-22)

The theme audit on main at #325 (a contrast table over all 22 themes and two base-only
fixtures, a slot-use probe, a guard probe and a pixel diff) found rules that broke on
bases they were not tuned on, slots nothing read, a publish path that took any partial
set, and guards that missed raw colours. This PR fixes them in that order. The theme
author's view (file format, live slots, how to check a file) is the new docs/THEMES.md,
which the help skill ships as `reference/themes.md`.

## 1. Scheme and surface agree; ids; publish failures

- `parseThemeFile` refuses a scheme its surface cannot carry: OKLab lightness at most
  **0.45** for dark, at least **0.70** for light (`SCHEME_LIGHTNESS`, `schemeProblem`). Past
  these white or black text cannot reach 7:1 with room left for statuses; the probe's
  mislabelled Warm Paper (`"dark"` on #f5ecd9, L 0.95) resolved statuses, link, diff and
  keywords to #ffffff with 15 pairs under 3:1. The error names the fix ("set "scheme":
  "light", or give a dark surface"); a mid grey gets "too light for dark and too dark for
  light". The curated surfaces are at most 0.33 (dark) and at least 0.95 (light).
- Ids follow PublishTheme's rule, `^[a-z0-9][a-z0-9-]{0,63}$` (`THEME_ID`).
- `startThemePublish` logs every failed publish (`console.warn("theme publish", err)`) and
  toasts the first refusal of the run: "Theme could not be published to pages" with the
  daemon's message and "Pages keep the last theme the daemon had." An unreachable daemon
  or one older than the RPC is logged only (the reconnect retries; there is nothing for
  the user to do).

## 2. PublishTheme takes exactly the slots

`theme.Frame.Check` now also requires the published names to be exactly `SlotNames()`
(102: read from `frame-defaults.json`, which `pnpm run themes` regenerates with the rules,
so the set cannot drift from the GUI's). InvalidArgument lists what is missing and what is
unknown ("missing 1 of the 102 slots: --cf-text; 1 unknown: --cf-lnik"); a refused publish
leaves the last good theme served (`Live.Publish` only swaps on success). Table tests in
`internal/theme` and `internal/api`; the mock daemon mirrors the rule (`mockThemeProblem`).
GUI and daemon always ship together, so no older GUI publishes a smaller set.

## 3. Every slot has a consumer, or is gone

Rule: a slot exists only when two unrelated components need the distinction. The probe
found 22 `--cf-*` slots nothing read. Now:

| slot | consumer |
| --- | --- |
| `placeholder` | shadcn Input, Textarea and Command (`placeholder:text-cf-placeholder`), the composer's placeholder, `::placeholder` in the base layer |
| `selection` | `::selection` in the base layer (fields keep shadcn's accent selection) |
| `code-foreground` | `.cf-markdown code` (inline and blocks), the thread's code blocks and a note's `pre` (blocks were `--syn-fg`, the same value; inline code was the body text, see below) |
| `text-secondary` | `.cf-markdown` blockquotes (were the muted text) |
| `icon-muted` | the sidebar's Pull Requests and Projects icons; a sidebar row's pin, created-by, waiting and tooltip icons |
| `chrome` | the sidebar's title band (the sidebar itself already derived from it) |
| `diff-addition-surface`, `-deletion-surface` | the diff view's base colours (`gitDecoration.added/deletedResourceForeground` in lib/codeTheme.ts): @pierre/diffs builds the line tints (20% dark / 12% light), the bars and the markers from them. Opaque, equal to `diff-addition` / `diff-deletion` by default (main's look), overridable apart from the +N/−N text in lists. Three earlier tries went through `--diffs-bg-*-override` in code.css and each broke something the pixel pass caught: a 12% alpha tint and an opaque 20% mix were mixed a second time (lines nearly flat), and the plain colour made the deleted line's striped gutter marker solid (the library draws it as `bg-deletion` 50% / base 50%, and the override replaces `bg-deletion`) |
| `control-active` | shadcn Button's ghost and outline variants when pressed |
| `accent-surface-foreground` | the composer's primary-member chip |
| `update`, `update-surface`, `update-text` | the update chip's available and downloading states |
| `border-strong` | the inline page lightbox's frame |
| `message-foreground` | the user's bubble text (kept: a theme that overrides the bubble's surface needs its pair) |
| `error-foreground` | already live through shadcn's `--destructive-foreground` |
| `warning-foreground` | already live (the sidebar's attention badge) |

Removed: `--cf-sidebar-row-active` (nothing has a pressed state distinct from selected) and
`--cf-icon` (the text colour for icons: the sidebar's navigation icons are muted, and the
first wiring, the New thread icon, sat on the accent-filled button and stopped matching its
label, nearly invisible in Graphite, Petros Dusk, Catppuccin Mocha and Rosé Pine; that icon
inherits the button's accent-foreground again).
Kept for pages only (frames read every slot, and the page-writing skills name them):
`success`, `info`, `highlight` and `update` `-foreground`, `chart-1` … `chart-6`.

Added: `--cf-<tone>-text` for success, warning, error, info, highlight and update (item 4).
**71 `--cf-*` slots** (67 + 6 − 2), 102 in all.

The live-slot list is in docs/THEMES.md; `src/themes/liveSlots.test.ts` holds it to the
code (every listed slot is read under src, no pages-only one is, the two lists partition
the set). `daemon.capabilities` names slot groups, not slots, so the list reaches the model
through the help skill's `reference/themes.md` (one line in the skill points at it; both
skills stay at their caps).

## 4. Contrast

The pair list is `src/themes/contrastPairs.ts` (`CONTRAST_PAIRS`, `contrastFailures`), so a
future import verb and the override editor use the same list. `contrast.test.ts` runs it on
the 22 themes and on the probe's two base-only themes (`contrast.fixtures.json`, not the
catalog). `pnpm run themes:check <file.json>` runs the same on a file. All pass.

- **Inline code** now reads `code-foreground` (= `syn-fg`, the theme's terminal foreground
  held at 4.5:1) instead of the body text. Where the two differ the contrast drops but stays
  AA: Solarized Light and Dark 7:1 → 4.6:1, Graphite Dark #fafafa → #d8dadf, Graphite Light
  #0a0a0a → #24292f. Not adjusted: the rule keeps code one colour (inline and blocks), and
  Solarized's terminal foreground is its body colour by design; stepping code to 7:1 would
  move every code block in those themes. A follow-up can raise the `code-foreground` floor
  if it reads too light.
- **Comments** are checked on the code block (`--cf-code-background` over the surface),
  which now resolves before the syntax colours: Dracula (2.59) and Kanagawa (2.98) fall
  back to the muted text, as the rule already did on the pane. The other syntax colours
  are stepped against the code block too.
- **Focus ring**: accent 35% toward the surface, then stepped to 3:1 on the surface and the
  canvas (light themes were 2.5–2.8, Solarized Dark 2.63). The 3px halo shadcn draws at
  `ring-ring/50` stays a halo; the full-strength `border-ring` carries the 3:1.
- **Muted text** steps until 4.5:1 on surface-sunken and control-hover as well as the pane
  and sheet (10 dark themes were 3.55–4.15). The sidebar's muted text is now its own rule:
  the muted text pulled toward the text until 4.5:1 on the sidebar and its selected and
  hovered rows (light themes were 3.8–4.4 on the selected row).
- **Status text on its tint**: the solid used to be the fill and the text, so light themes
  stepped yellows to brown. Split:
  - `--cf-<tone>`: the **fill**, stepped to 3:1 on the surface and canvas (non-text
    contrast). Light warning fills stay bright: GitHub Light #946300 → #9a6700 (its base),
    Latte #8f5700 → #b77100, Gruvbox Light #8c5900 → #b2730d, Rosé Pine Dawn #925b00 →
    #b77400, Atom One Light #7f662c → #9e834a, Solarized Light #846300 → #a67e00; Graphite
    Light unchanged (its base passes).
  - `--cf-<tone>-text`: the fill stepped until 4.5:1 on the surface, the canvas and the
    tint over either. Every `text-cf-<tone>` (271 sites in 86 files, specs too) is now
    `text-cf-<tone>-text`; thread.css's tones read the text slots and lose their light-only
    `color-mix(… 85%, black)`; shadcn's destructive menu items use `text-cf-error-text`.
  - `-surface` stays the fill at 10%; `-foreground` stays text on the fill (now the theme's
    surface or text, else black or white: light warning badges get black digits).
  - Fills, borders, dots, bars, tag accents and cite marks keep the fill.
  - Diff colours are the status text (`diff-addition` = success-text, …), so +N/−N and
    file letters read at 4.5:1.

## 5. Rules that collapsed

- `control`, `control-hover` and `surface-sunken` were one formula (14% dark / 7% light).
  Now four ordered steps toward the text: sunken 8% / 4% (wells, light code blocks: a
  hovered row stays visible on a well), control 11% / 5.5% (a secondary button at rest),
  control-hover 14% / 7% (unchanged, 78 sites), control-active 20% / 11%.
- `sidebar-row-selected`: the sidebar 10% toward the text, then in 1% steps until 1.25:1
  against the sidebar (the probe's deep blue was 6/255 from its sidebar, GitHub Dark 1.13).
  Hover stays the selected row at 50% over the sidebar (half its step).
- `accent-foreground` (and every status `-foreground`) picks the surface or the text as
  before, else black or white, whichever reads better: one of them always reaches about
  4.58:1, so an overridden accent or a mid-tone fill always gets a readable label. The
  accent's own nudge still keys on the surface and text, so no curated accent moved (black
  as the first choice would have turned four light themes' primary buttons black-on-colour).

### Overrides

Graphite Light's hand-picked greys collapsed the steps again (#f5f5f5 for sunken, control
and hover) and failed two pairs. Dropped the three control overrides (the rules give
#f4f4f4 / #efefef / #ebebeb); stepped the rest to their floors: focus #a1a1a1 → #8a8a8a (3:1
on the sheet), selected row #e1e1e1 → #d7d7d7 (1.25:1), muted #6d6d6d → #6a6a6a (4.5:1 on a
hovered row). Overrides: 12 in 4 themes (was 15).

## 6. Guards

`src/design/guards.test.ts`, "slot-name guard": a `cf-*` colour utility must name a slot and
a `var(--cf-*)` a slot or a property declared under src (`--cf-zoom`, Ember's
`--cf-flame-*`, the backdrop's `--cf-backdrop-*`); a misspelt or retired slot fails.

`lib/palette.test.ts` with `src/design/colourLiterals.ts` now also finds, in literals (AST,
not lines): a named colour where a colour goes (`fill="white"`, `{ color: "tomato" }`,
`setProperty(…, "red")`; a tone key `"red"` elsewhere is data), CSS declarations with a
colour value in a literal that holds CSS (`<style>` strings, templates), hex anywhere in a
literal (three or four digits only after a CSS separator, so "PR #142" passes), and any
literal colour inside a Tailwind arbitrary value or property (`bg-[tomato]`,
`[background:#fff]`, `color-mix` with a literal argument, `hwb()`, `color()`). Stylesheets:
every `.css` under src (was components and index.css), named colours in declaration
values. 25 new cases plus the extended line patterns.

Dynamic class names (`bg-${tone}/10`, `"text-cf-" + tone`) cannot be read statically; the
rule (map a tone to whole class strings) is in `colourLiterals.ts` and THEMES.md. A grep
found none (the one template, `lib/utils.ts`, builds type-role names for tailwind-merge).

## Pixel comparison

Playwright WebKit, 1440×900 at 2×, against two mock daemons, all 22 themes, nine shots each
(thread: permission, top, bash + diff, diff, answer; sidebar; Settings General and
Appearance; the MCP panel). Compared twice: this branch against 2719b6fe (before the
theme-slots series) and against main (d306ac42); the main pass isolates this PR. 196 of 198
shots change against main (Graphite Dark's two Settings shots do not). Every region was traced
to a slot change (a helper matched each region's colour pairs to the resolved slots of main
and the branch, and the flagged ones were read from their crops). Per category, against main:

| category | slots | themes | typical / max Δ (per channel /255) |
| --- | --- | --- | --- |
| wells and light code blocks lighter | surface-sunken, code-background, code-foreground | 21 | 6 / 24 |
| selected and hovered sidebar rows a step stronger | sidebar-row-selected, sidebar-row-hover | 17 | 7 / 37 |
| muted text, placeholders, row icons more contrast | text-muted, sidebar-muted-foreground, icon-muted, placeholder | 16 | 13 / 27 |
| status text (sidebar line 2, chips, banners, thread tones) | the `-text` slots | 15 | 10 / 24 |
| status fills, dots, chip tints and borders (light: brighter; some dark reds less lifted) | the fills and `-surface` | 11 | 23 / 253 (the attention badge's digit, white → black on the brighter amber, light themes) |
| syntax steps on the code block; comments to muted (Dracula, Kanagawa, …) | syn-*, sh-* | 14 | 10 / 77 |
| focus ring stepped to 3:1 | focus | 8 | 13 / 29 |
| diff +/- tint and marker hue (the diff colour is now the status text) | diff-addition, diff-deletion | 15 | 10 / 24 |
| links | link (info-text) | 9 | 11 / 15 |
| inline code: body text → code foreground | code-foreground | 4 (Graphite ×2, Solarized ×2) | 24 / 37 |
| secondary buttons, hover rows (Graphite Light's derived greys) | control, control-hover | 3 | 10 / 12 |
| clock minute rollover between shots (noise) | — | 22 | — |

The two regressions the pass found (the New thread icon on the accent button; the deleted
line's striped marker drawn solid) are fixed and recaptured: the icon box is identical to
main in all 22 themes and the marker is identical pixel for pixel. Maxima of 130-166 in the
dark themes are glyph edges and the clock.

Per theme (against main, dominant causes): Atom One Dark, Ayu Mirage, Catppuccin Mocha,
Everforest, Kanagawa, Petros Dusk, Tokyo Night: sidebar rows and muted text; GitHub Dark,
Rosé Pine: sidebar rows; Nord, Gruvbox Dark: muted text (Gruvbox also its red); Solarized
Dark: sidebar rows, muted text, syntax, inline code; Dracula: diff and status reds, syntax
and comments; Monokai Pro: wells, status text, syntax; Graphite Dark: wells and inline code;
GitHub Light, Catppuccin Latte, Gruvbox Light, Rosé Pine Dawn, Atom One Light, Solarized
Light: lighter wells and code blocks, then the sidebar rows, status text and fills; Graphite
Light: sidebar rows, status text, its derived control greys.

Against 2719b6fe the same, plus the differences the theme-slots-2 PR accepted (resting chip
tints /15 → /10 on the MCP panel in every theme, Graphite Light's palette); the
other-scheme preview text was not in these scenes.

## Left out

- Loading user theme files, a `theme.import` verb, the Settings override editor.
- Dimmed rows: Settings' dimmed rows use `opacity-45`, not a colour; moving them to
  `text-secondary` would change what "dimmed" means there. Left as is.
- Focused cards: `border-strong` went to the lightbox only; a focused composer keeps its
  ring.

## Verified

- `make check` green; `make gui-e2e` green apart from `workspaces.spec.ts`, which is flaky
  on main too (2 of 16 repeated runs there, different tests); its runs pass here alone.
- `pnpm run themes:check` on the probe's fixtures: both pass; the mislabelled file is
  refused for its id, and with the id fixed, for the scheme.
- The pixel passes above (all 22 themes, both baselines), with the regressions they found
  fixed and recaptured.
- `make gui-build`. The daemon must be restarted: `internal/theme` (the slot-set check and
  the regenerated defaults) and the skills changed.
