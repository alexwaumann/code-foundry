# Themes

How a Code Foundry colour theme is written, what each colour does and how to check one. The
app resolves every colour from a small base by rules (`gui/frontend/src/themes/slots.ts`);
pages the model writes get the same colours from `/cf/theme.css`. Your own themes are files
in the themes directory (`theme save`, `theme show`, `theme duplicate`; `theme edit` opens
one in the Themes page's editor), read by the same rules as the curated ones: the GUI and
the daemon refuse the same files.

Run from a thread, `theme save` also puts a card in that thread's conversation (the theme's
swatches and contrast, Undo back to the slot's previous theme, Edit, Apply when not applied)
and, when it changes what a slot shows (another theme, or new colours), a toast. While the app
is open, `theme save` prints the app's contrast check of the file it wrote: each failing pair
with its ratio and the one it needs (`contrast: ok` when none), and the stale pins (pins whose
rule the base has moved since they were made); `theme check <id>` prints it again. `theme ask "<description>"` (the Themes page's Ask the model) starts a
thread with no project that makes the theme described; `--pair <id>` asks for the other
scheme's pair of one of your themes.

## A theme file

```json
{
  "id": "warm-paper",
  "name": "Warm Paper",
  "scheme": "light",
  "pair": "deep-blue",
  "source": "where the colours came from",
  "base": {
    "canvas": "#e8dcc4", "surface": "#f5ecd9", "text": "#4a3b2a", "accent": "#c0622f",
    "success": "#6b8e23", "warning": "#d4a017", "error": "#c0392b", "info": "#3a7ca5",
    "highlight": "#8e5ba8", "link": "#3a7ca5",
    "terminal": {
      "foreground": "#4a3b2a", "cursor": "#4a3b2a", "cursorText": "#f5ecd9", "selection": "#d9ccb0",
      "ansi": ["#f5ecd9", "#c0392b", "#6b8e23", "#d4a017", "#3a7ca5", "#8e5ba8", "#2a9d8f", "#d9ccb0",
               "#a8977a", "#e05a47", "#88a83a", "#e8b830", "#5a9cc5", "#ae7bc8", "#4abdaf", "#4a3b2a"]
    }
  },
  "overrides": { "--cf-sidebar-row-selected": "#d2c5ae" }
}
```

- **Required**: `id`, `name`, `scheme`, `source` (optional in your own themes, which may
  also have `from` and `created_by`), and `base` with `canvas`, `surface`, `text`,
  `accent`, `success`, `warning`, `error`, `info`, `highlight` and `terminal.foreground` and
  `terminal.ansi`. **Optional**: `pair` (the theme of the other scheme it belongs with),
  `base.link` (the info colour's text when absent), `terminal.cursor` (the foreground),
  `terminal.cursorText` (ignored under 3:1 on the cursor), `terminal.selection` (the
  foreground at 20% over the surface; replaced under 3:1 against the foreground) and
  `overrides`. Any other field is refused.
- **id**: lowercase letters and digits, words joined by single dashes, at most 64
  characters (`^[a-z0-9]+(?:-[a-z0-9]+)*$`). The daemon refuses any other id.
- **Colours** in `base` are `#rrggbb` (any case; stored lowercase).
- **ANSI order**, 16 colours: black, red, green, yellow, blue, magenta, cyan, white, then the
  bright eight in the same order. The syntax colours start from them (keywords ANSI 5 dark /
  1 light, functions 4 / 5, types 3 / 4, strings 2, numbers 6, comments 8 / 7).
- **Scheme and surface**: the surface's OKLab lightness must suit the scheme: at most 0.45
  for `dark`, at least 0.70 for `light`. Past these the text cannot reach 7:1 with room left
  for the statuses, so the rules run out of headroom (a "dark" theme on a paper surface
  resolves its statuses, link and syntax to white). A mid grey suits neither. The file is
  refused with the fix ("set "scheme": "light", or give a dark surface").

## Overrides

`overrides` sets individual slots (below) to final values: applied as is, with no
contrast guard, and every slot derived after it follows (override `--cf-surface` and the
sunken, border and control mixes move with it). Use them only for what the rules cannot
say; check the file afterwards. A key must be one of the slots below: a misspelt or
removed one (`--cf-icon`, `--cf-sidebar-row-active`) refuses the file. The Themes page's
editor calls an override a pin.

Values are `#rrggbb`, or `#rrggbbaa` for the slots that are tints and composite over what
they sit on: `--cf-accent-surface`, `--cf-selection`, `--cf-message-surface`,
`--cf-code-background` (dark themes; light ones use an opaque well),
and `--cf-<tone>-surface` for success, warning, error, info, highlight and update. Give
every other slot an opaque colour. `--cf-diff-addition-surface` and
`--cf-diff-deletion-surface` are the colours the diff view builds its lines from (it mixes
20% dark / 12% light of them into the pane, and draws the bars and markers in them), not
the line colour itself; `--cf-diff-addition` / `-deletion` are the +N/−N text elsewhere.
The component names, the terminal (xterm needs opaque hex) and the syntax
colours are checked opaque.

## Slots

102 in all: 71 `--cf-*` slots, 21 terminal colours (`--terminal-fg`, `-cursor`,
`-cursor-accent`, `-selection`, `-selection-inactive`, `-ansi-0` … `-ansi-15`) and 10 syntax
colours (`--syn-fg`, `-kw`, `-fn`, `-type`, `-str`, `-num`, `-com`, `--sh-cmd`, `-flag`,
`-str`). The rule for each is in `slots.ts` (`SLOTS[].rule`). A slot exists only when two
unrelated places need the distinction.

Each status tone (success, warning, error, info, highlight, update) has four:
`--cf-<tone>` is the **fill** (dots, bars, badges; at least 3:1 on the surface and canvas,
so a bright yellow stays bright), `--cf-<tone>-text` is **text** in that tone on the surface,
the canvas or its own tint (at least 4.5:1 on all four), `--cf-<tone>-surface` the **tint**
(10%), and `--cf-<tone>-foreground` text **on a solid fill**.

### Live slots

Every slot is published to pages (`/cf/theme.css`, `/cf/theme.json`, the `cf:theme`
message), so an override of any of them reaches a page that uses it. These are the ones the
app itself paints with, so an override shows in the app:

- Surfaces: `--cf-canvas`, `--cf-surface`, `--cf-chrome`, `--cf-surface-raised`,
  `--cf-surface-overlay`, `--cf-surface-sunken`, `--cf-border`, `--cf-border-strong`,
  `--cf-divider`
- Text: `--cf-text`, `--cf-text-muted`, `--cf-text-secondary`, `--cf-placeholder`,
  `--cf-icon-muted`, `--cf-link`
- Interactive: `--cf-accent`, `--cf-accent-foreground`, `--cf-accent-surface`,
  `--cf-accent-surface-foreground`, `--cf-focus`, `--cf-input`, `--cf-control`,
  `--cf-control-hover`, `--cf-control-active`, `--cf-selection`
- Status: `--cf-success`, `--cf-success-text`, `--cf-success-surface`, `--cf-warning`,
  `--cf-warning-text`, `--cf-warning-surface`, `--cf-warning-foreground`, `--cf-error`,
  `--cf-error-text`, `--cf-error-surface`, `--cf-error-foreground`, `--cf-info`,
  `--cf-info-text`, `--cf-info-surface`, `--cf-highlight`, `--cf-highlight-text`,
  `--cf-highlight-surface`, `--cf-update`, `--cf-update-text`, `--cf-update-surface`
- Sidebar: `--cf-sidebar`, `--cf-sidebar-foreground`, `--cf-sidebar-muted-foreground`,
  `--cf-sidebar-row-selected`, `--cf-sidebar-row-hover`, `--cf-sidebar-border`
- Thread: `--cf-message-surface`, `--cf-message-foreground`, `--cf-code-background`,
  `--cf-code-foreground`, `--cf-quote-border`
- Diff: `--cf-diff-addition`, `--cf-diff-addition-surface`, `--cf-diff-deletion`,
  `--cf-diff-deletion-surface`, `--cf-diff-modified`
- Terminal and syntax: all 31

Pages only (the app has no place for them yet; a page the model writes may use them):

- `--cf-success-foreground`, `--cf-info-foreground`, `--cf-highlight-foreground`,
  `--cf-update-foreground`, `--cf-chart-1`, `--cf-chart-2`, `--cf-chart-3`, `--cf-chart-4`,
  `--cf-chart-5`, `--cf-chart-6`

## Checking a theme

One of your themes: `theme check <id>` prints the running app's check (the pairs below), as
`theme save` does. Any file, in a checkout of the repository, from `gui/frontend`:

```
pnpm run themes:check path/to/theme.json
```

It reads the file as the app would (the fields, the id, the hex, the scheme against the
surface, the override names) and checks every contrast pair in
`src/themes/contrastPairs.ts` on the resolved slots: body text 7:1 on the pane; muted,
secondary and placeholder text, links, status text (on the pane, the sheet and its own tint),
text on fills and accents, code and syntax 4.5:1; fills, focus rings, comments and chart
series 3:1; the selected sidebar row 1.25:1 against the sidebar. A file may hold one theme
or an array. The curated themes and two base-only fixtures pass every pair
(`src/themes/contrast.test.ts`).
