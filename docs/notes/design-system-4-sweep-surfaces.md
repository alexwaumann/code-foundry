# Design system 4: the surfaces' type and radius sweep

PR 4 of 4 of the design-system normalization (1: tokens + guard, #126; 2: shell, #129;
3: the shell-side components; 4: this). It moves every Tailwind size, arbitrary leading and
off-scale radius in `src/components/{pr,prs,projects,usage,overview,actions,mcp,agents,linkedprs,workspace}`
onto the type roles and the radius scale from PR 1. Frontend only.

## Mapping

Everything moves up one notch (12 → 13, 14 → 15); 13px stays 13.

| before | after | where |
| --- | --- | --- |
| `text-sm` body copy, empty states, table rows (`text-sm text-muted-foreground`) | `text-body` (+ `text-muted-foreground`) | PR/Projects rows, panel messages, banners |
| `text-sm font-semibold` panel/section headings, pane-header page titles | `text-heading` | Agents/MCP/Workspace/Linked PRs/Worktree headers, SectionTitle, Projects/Pull Requests/Usage `h1` |
| `text-[15px] leading-snug font-semibold` (PR title) | `text-heading` | PullRequestSurface |
| `text-[13px] font-semibold`, `text-xs font-semibold` sub-sections | `text-subheading` | Usage page/surface "Daily", "By model", "Tokens"; MCP server name |
| `text-sm font-medium` / `text-[13px] font-medium` on buttons, tabs, form labels | `text-label` | Merge, Review, PR state chip, PR section toggles, ActionDialog labels, month tiles |
| `text-xs font-medium` on dense in-row buttons | `text-body-sm font-medium` | MCP Reconnect / tools toggle, action status-line buttons, review composer submit |
| `text-xs`, `text-[13px]` row/panel content | `text-body-sm` | file/log/check rows, agent rows, MCP tool rows, timeline lines, reviewer chips, inner tabs |
| `text-xs text-muted-foreground` secondary lines | `text-caption` | meta lines, counts, ages, hints, Freshness |
| `text-[11px]`, `text-[11.5px]`, `text-[10px]`, `text-[10.5px]` small/muted, chips | `text-caption-sm` (+ tone colour, `font-medium` on chips) | agent stats, state chips, pills, usage legend/axis, unpriced tags, `wt` tag |
| `text-[11px] tracking-wide uppercase` table headers | `text-overline` | Pull Requests tables |
| inline mono names (`font-mono text-[11.5px]`, `font-mono text-[13px]` branch) | `text-code` (+ colour) | MCP tool name/version, agent last tool, worktree branch |
| mono blocks (`font-mono text-xs leading-[17px]`, `text-[12.5px] leading-[19px]`) | `text-body-sm font-mono` / `text-caption font-mono` | action output and command field, sync line, file rows |
| `text-2xl font-semibold` stats | `text-title` | Pull Requests month tiles |
| `text-[44px]` / `text-[32px] leading-none font-semibold tracking-[-0.02em]` totals | `text-title` | Usage page and Usage surface totals (see below) |
| bare `rounded`, `rounded-[5px]` | `rounded-sm` | small buttons, chips, segmented items, actions menu edit button |
| `rounded-[10px]` | `rounded-lg` | MCP server cards |
| `rounded-[2px]` on the 8px model swatch | none (square) | `rounded-sm` would make an 8px square a circle, like the status dots |

`leading-[…]`/`leading-snug`/`leading-[1.45]` next to a role went (the role sets it);
`leading-none` stays on the inline `unpriced` tag. `tracking-[-0.02em]` went with the totals
(`text-title` tracks tight). `font-normal` on counts inside headings went (captions are 400).
Weight utilities kept as modifiers (`font-medium` on chips, names, timeline headlines) still
count in the guard's weight category until PR 3 drops it.

### Colour

Every role sets a colour, so a role on an element that used to inherit a tone would turn
it foreground. Where that mattered the role went on the toned element (ChecksBadge: the
role sits on the outer span with the tone; the label inside has no size) or a colour
modifier follows it (`text-caption-sm text-popover-foreground` on the chart tooltip,
`text-body text-muted-foreground` for muted body copy, `text-label text-primary-foreground`
on Merge).

## Concentric radii

- Projects page project and workspace cards `rounded-md` → `rounded-lg` (cards in the padded
  pane); their header NavRows `rounded-lg` (keeping `rounded-b-none` when expanded) so the
  selected background follows the card's corner; worktree and page-layout member rows inside
  the card's `p-0.5` `rounded-md`.
- Pull Requests tables `rounded-md` → `rounded-lg`, their rows `rounded-md`; the error
  banner `rounded-lg`.
- Worktree overview's "Not a git repository" box and the PR surface's stale banner
  `rounded-md` → `rounded-lg`.
- MCP cards were already 10px (`rounded-[10px]` → `rounded-lg`); their buttons stay
  `rounded-md`. The PR inner tabs (`rounded-md` in a `rounded-lg p-0.5` strip), the PR review
  threads (`rounded-lg`) and the review composer (no rounded container; textarea and buttons
  `rounded-md`) were already right. Usage segmented items `rounded` → `rounded-sm` inside the
  `rounded-md` strip.

## Row heights

Content height against the fixed row (the workspace members measured in WebKit against the
mock, the rest from the roles' line heights):

| list | row | content before → after | change |
| --- | --- | --- | --- |
| Workspace surface members (`PANEL_MEMBER_ROW_HEIGHT`) | 48 | 43 → 46 | none, fits |
| Linked PRs (`LINKED_PR_ROW_HEIGHT`) | 48 | 22 + 2 + 16 = 40 | none |
| Projects worktrees / members (`ROW_H`, `MEMBER_ROW_HEIGHT`) | 32 | 22 | none |
| Pull Requests rows (`ROW_H`) | 28 | 22 | none |
| Worktree overview files / log (`FILE_ROW_H`, `LOG_ROW_H`) | 24 | 18 | none |
| PR timeline / conversation (`VirtualStack` estimates 72 / 96) | measured | — | none (estimates only) |

No constant needed to move: the 13px role's 18px line fits every 24px row and the 15px
role's 22px line every 28/32px row.

## Panel widths and zoom

Side panel at 280 / 340 / 400 / 420px, 100% and 150% zoom, every element that clips
(`overflow: hidden` or an ellipsis) listed before and after: no header title, tab label,
button or inner-tab bar clips at any width. The PR inner bar's container-query steps
(counts hide below 400, toggle compacts below 480) still hold: nothing in it clips at
400/420. New ellipsis truncation only on lines that already truncate at 280: the MCP
"Checked … ago" line, the Agents subline and the worktree path now also ellipsize at 340
(they fit there before by 6-24px), and the repo slug in the PR header loses ~6px.

## The guard

`pnpm run guards:allow`: 103 files {size 481, weight 156, leading 6, radius 40} →
93 files {size 262, weight 122, leading 1, radius 24}. These ten directories have no size,
leading or radius hit left; their remaining entries are weight modifiers only, which go when
PR 3 removes the weight category.

## Gotchas

- **The Usage totals shrink.** 44px (page) and 32px (surface) display numbers have no role;
  the closest is `text-title` (22). They are still the largest text on their surfaces, but
  much smaller than the session-usage sketch. A `text-display` role (needs `tokens.ts` for
  `cn`'s merge table and a `roles.test.ts` row, both PR 3's files) would restore them.
- **Pane-header page titles are `text-heading`, not `text-title`.** Projects, Pull
  Requests and Usage `h1`s were `text-sm` in the 44px PaneHeader beside the thread title;
  22px would not sit in that band. Settings and Themes (PR 3) should match.
- **`cn` drops `leading-none` when a role follows it** (tailwind-merge: a font size after a
  leading removes it), so the Label primitive's `leading-none` goes when a role is passed in
  `className`. That is what we want for these labels.
- **The 8px swatch** has no 2px step on the scale; square reads as a legend swatch next to
  the round status dots.
