# Design system 3: the type and radius sweep, chrome

PR 3 of 4 of the design-system normalization (1: tokens + guard, #126; 2: shell, #129; 3:
this; 4: the surfaces and pages). Frontend only. Every file the guard listed under
components/{compose, ui, thread, sidebar, update, addproject, publish, palette, session,
help, snooze, start, bottom, gitops, panel, terminal, command, settings, themes} and
surfaces/Placeholder.tsx is now on the type roles and the radius scale; their allowlist
entries are gone. App.tsx had no hits.

## Mapping

Tailwind's steps moved up one notch onto the roles (text-xs 12 → 13, text-sm 14 → 15).

| before | after | where |
| --- | --- | --- |
| `text-sm` body copy, empty states, notices | `text-body` (15/22) | composer errors, terminal overlays, settings messages, placeholders, help shortcuts, session links |
| `text-sm font-medium` (buttons, tabs, menu items, form labels) | `text-label` (14/20 medium) | Button base, menu/select/palette items, setting titles, snooze month |
| `text-xs`, `text-[12px]`, `text-[12.5px]`, `text-[13px]` row and panel content | `text-body-sm` (13/18) | sidebar rows, tooltips, tabs, panel tabs, completion card, agents strip |
| `text-xs text-muted-foreground`, `text-[13px]` muted | `text-caption` (13/18 muted) | detail lines, dialog descriptions, hints, picker footers |
| `text-[10px]`, `text-[11px]`, `text-[11.5px]` (muted or chips) | `text-caption-sm` (12/16) + weight/colour | sidebar line 2, chips and badges, ages, meta lines, kbd |
| `text-[10px]/[11px] … uppercase tracking-wide(r)` | `text-overline` (11/16) | sidebar section headers, cmdk group headings, help/start/gallery section labels |
| `text-sm font-semibold` pane headings | `text-heading` (15/20 semibold) | Settings/Themes h1, Settings group h2 (was `text-base`, 16), dialog titles |
| `text-[13px] font-semibold` | `text-subheading` (14/20) | thread tooltip name; panel empty-state headings (were `text-sm font-medium`) |
| `text-xl`/`text-2xl font-semibold` h1 | `text-title` (22/28) | composer heading (24 → 22), start page (20 → 22) |
| `text-base font-semibold tracking-tight` | `text-brand` (new, 17/20 semibold tight) | the sidebar's app name only |
| bare `rounded`, `rounded-[3px]`, `rounded-[4px]` | `rounded-sm` (4) | kbd, chips, checkbox, code chips |
| `rounded-[7px]`, `rounded-[0.5em]`, `rounded-[inherit]` | `rounded-md` (6) | update dialog button, prompt tags, attachment thumbs |
| `rounded-[10px]`, `rounded-2xl` (16) on cards | `rounded-lg` (10) | agents strip, composer card, completion card |
| `rounded-[15px]` app icon | `rounded-2xl` (16) | update dialog |

shadcn primitives (components/ui) changed only size, weight and radius classes: Button
`text-label` (sm stays text-label, 14 as before; xs `text-body-sm font-medium`), input /
textarea / select trigger / command input `text-body`, badge `text-caption-sm font-medium`,
kbd `text-caption-sm` (sm with `leading-none` to stay 16px tall), dialog title
`text-heading`, description `text-caption`, tooltip `text-body-sm`, menu, select and cmdk
items `text-label`, cmdk group headings `text-overline`, menu labels and shortcuts
`text-caption-sm`, tab and segmented-radio triggers `text-body-sm font-medium`.

## Colour: roles set one, `text-inherit` keeps the parent's

Every block role sets a colour. That changes elements that used to inherit theirs: ghost and
outline Buttons (and their icons) take the colour of the row or header they sit in. So
Button's base is `text-label text-inherit`: a variant's colour replaces `text-inherit` (cn
merges them), and without one the label inherits as before. ui/label.tsx does the same.
Consequence, written on Button: a role passed in className brings its size but not its
colour, so write the colour too (`text-caption text-muted-foreground`), as SessionParts and
HeaderActions do. roles.test.ts pins the merge.

## Concentric radii

- Composer card (new-thread `Composer.tsx`, thread `.ccard` in thread.css and the prompt
  stack's top corners) and the completion card: 16 → `rounded-lg` (10), one step inside the
  content pane's `rounded-pane` (12).
- Attachment thumbnails inside the composer card: `rounded-lg` → `rounded-md`.
- Agents strip above the composer: `rounded-[10px]` → `rounded-lg`, matching the card.
- Update dialog: dropped its `rounded-[10px]` override, so it is `rounded-pane` like every
  dialog; its busy-threads and failure boxes stay `rounded-lg` inside it, its primary button
  `rounded-md`.
- Select items `rounded-sm` → `rounded-md` like the dropdown and context menu items inside
  their `rounded-lg` popovers. cmdk items stay `rounded-sm` inside cmdk's `rounded-md` root.

## Heights

- Sidebar rows are measured (`rowHeight + SECOND_LINE`, 26 + 15 compact). The name line was
  13px at the inherited 1.5 leading (19.5) and line 2 11px (16.5); now 18 + 16, so the
  content is 2px shorter inside the same 41px row and the constants stay. Headers (26) and
  single-line rows unchanged.
- Completion card: `ROW` (h-7) is fixed; the hints footer is 1 + 12 + 16 = 29 as before.
- Attention badge on the bell: 9px text was unreadable as a role; it is `text-overline`
  (11) and the badge grows from 14 to 16px.
- Palette and menu items keep 20px line height (`text-label`), so their heights are unchanged.

## Guard

- **Weight category removed** from scan.ts, the allowlist and the test: with sizes banned a
  `font-*` only ever modifies a role. CLAUDE.md says so.
- **Arbitrary colours are not sizes**: `text-[color-mix(…)]` (the prompt tags' tint) was
  counted as a size; the size pattern now skips colour values (colour-mix, oklch, rgb, hsl,
  `#`, `color:`). The palette guard still polices arbitrary colours.
- `text-brand` joined index.css, tokens.ts (so cn merges it) and roles.test.ts.
- No new test for "these directories stay at zero": a file not in the allowlist may have no
  hits, so the allowlist is the record.

Allowlist totals (files / size / weight / leading / radius): before 103 / 481 / 156 / 6 / 40;
after 29 / 219 / - / 5 / 16. The 29 are PR 4's directories, untouched.

## Gotchas

- `@theme inline` inlines the radius tokens, so `var(--radius-lg)` does not exist at runtime;
  thread.css writes 10px with a comment.
- The ThemeGallery mirrors real components with their own markup; it follows the same
  mappings. Its sample composer's third picker now reads "Auto": with 13px pickers "Accept
  edits" ran under the send button at a 1280px window.
- Sidebar line 2 at 12px truncates a few characters earlier at the default width ("Needs input
  · Bash zig build -Doptimize=R…").
- thread.css (the rendered thread's own typography) is CSS, not scanned, and out of scope.
- tailwind-merge drops an earlier `leading-*` when a role follows it (font-size conflicts with
  line-height), so a role passed to a primitive that had `leading-none` replaces both.

## Verified

- `make check` green.
- `make gui-e2e` (`E2E_MOCK_PORT=7833 E2E_VITE_PORT=9288`): see the PR.
- Mock daemon, Playwright WebKit, dark and light, before/after: thread with composer and
  bottom shell, palette, Settings, Themes, Add Project, Update dialog. The app name at 17px
  fits at SIDEBAR_MIN at 90% and 150% zoom (layout.spec).
