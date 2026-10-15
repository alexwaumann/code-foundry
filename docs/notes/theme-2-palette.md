# Theme 2: palette classes become semantic colour tokens

Second of five PRs towards a theme engine (tokens, palette sweep, tooltip sweep, form
controls, radio-group + cleanup). PR 1 (#106) added the tokens; this one moves every
component onto them, so no component picks a raw Tailwind palette colour any more and an
imported theme recolours the whole UI. Frontend only.

## Counts

`(text|bg|border|ring|fill|stroke|from|to|accent|decoration|outline|shadow|divide)-(amber|red|emerald|sky|violet|yellow|orange|green|blue|neutral|zinc|slate|stone|gray)-N`
over `gui/frontend/src`: 299 occurrences in 45 files before, 0 in components after (the
8 left are the guard's own examples and one historical comment in `index.css`).

## Mapping

| Tailwind | Token | Notes |
| --- | --- | --- |
| emerald | `success` | |
| amber, yellow (daemon "connecting" dot), orange (git-repository folder in path completion) | `warning` | yellow-500 and orange-600/400 had no token of their own; amber is the nearest hue |
| red | `destructive` | |
| sky | `info` | the update dialog's release-notes link is `text-link` (it is a link) |
| violet | `highlight` | workspace chips, merged PRs, worktree branch icons |

- A `X-600 dark:X-400` pair becomes one class (`text-warning`); the variable switches per
  scheme. Same for tints: `bg-sky-500/10 dark:bg-sky-400/10` is `bg-info/10`, opacity
  suffixes (`/15`, `/30`, `/[0.07]`) are kept.
- Off-pair shades take the token at the same opacity:
  - `-700` light text (chips, the update chip, MCP badges, PR badges) is now the 600: a
    shade lighter in light, unchanged in dark.
  - `-300` dark text (`text-amber-300`, `text-violet-300` in the workspace chip,
    `dark:text-emerald-300`) is now the 400: a shade darker in dark.
  - Dark-only `-400` classes (the Pull Requests page, worktree overview, Projects page
    icons, `text-sky-400/90` folder icons) are unchanged in dark and now the 600 in
    light, where the 400s were washed out (the light workspace chip and PR checks were
    hard to read before).
  - Solid `-500` dots and fills (`bg-emerald-500`, `bg-red-500`, `bg-amber-400`) are the
    token: 600 light / 400 dark.
  - **Two shades:** the stale-copy banners (`PullRequestSurface` Banner,
    `PullRequestsPage` warn note) were `text-amber-800` light / `text-amber-200` dark on
    an amber tint. They are `text-warning` now (600 / 400): same hue, more saturated.
    Neither a token nor a token with opacity gets nearer; a `color-mix` with the
    foreground would, but was not worth a bespoke class for two banners.
  - **Attention badge** (bell count): was white on amber-500 (light) / black on
    amber-400 (dark); now `bg-warning text-warning-foreground`, so the light badge is
    near-black on amber-600. Visible in light (the digit goes dark), and the contrast
    goes from about 2:1 to 6:1; this is what `--warning-foreground` exists for.
- No new variables.

### Outside the class regex

- **`thread.css`** (rendered thread): `--t-sky/amber/emerald/red` were literal oklch
  copies of Tailwind shades (700s in light for small-text contrast, 400s/amber-300 in
  dark). Dark now uses the tokens directly; light keeps the darker step as
  `color-mix(in oklab, var(--info) 85%, black)` (15% black turns the default 600s into
  about the 700s: sky exactly, emerald and amber within a hair). `--t-*-500` tints are the
  tokens. The drag border is `color-mix(in oklab, var(--info) 70%, transparent)`.
- **Tag chips** (`compose/tagStyle.ts`, `thread/UserBubble.tsx`): the skill, file and
  image accents were arbitrary oklch pairs (hue 300, 230, 152); they are
  `[--chip-accent:var(--highlight|info|success)]`. The chip mixes only 11-34% of the
  accent, so the difference is within a shade (highlight is a bit more saturated than
  the old skill violet).
- **Markdown task-list checkbox** (`.cf-markdown input[type=checkbox]`): stays
  `accent-color: oklch(0.588 0.158 241.966)` (sky-600 in both schemes). `--info` or
  `--link` is sky-400 in dark, a visible change on a native control; PR 4 (form
  controls) is the place to decide its look.
- **`ui/*`**: no palette colours were left there. `button.tsx`'s destructive variant
  keeps shadcn's stock `text-white` on `bg-destructive` / `dark:bg-destructive/60`;
  `--destructive-foreground` is near-black in dark, which would need a solid red-400
  button (a visible change). `dialog.tsx`'s `bg-black/40` overlay is stock too.

## Guard and allowlist

`src/lib/palette.test.ts` reads every `src/**/*.{ts,tsx}` as text
(`import.meta.glob(..., { query: "?raw" })`) and fails, listing file:line, on:

1. a palette class (any hue, any shade, any variant prefix or opacity);
2. an arbitrary colour in a class: `bg-[#...]`, `text-[oklch(...)]`,
   `[--x:oklch(...)]` (`var(--token)` and `color-mix(...)` inside brackets are fine);
3. a colour literal in non-test TypeScript (`"#rrggbb"` as a whole string, `oklch(`,
   `rgb(`, `hsl(`...) outside the allowlist.

It also fails on a stale allowlist entry. The allowlist (colours that are data, not
theme):

| File | What | Why |
| --- | --- | --- |
| `icons/ClaudeMark.tsx` | `CLAUDE_ORANGE` | Anthropic's brand colour |
| `lib/usage.ts` | `SLOT_COLORS` | Usage page: one fixed categorical colour per model family (DESIGN.md). A later PR can map them to `--chart-1..5` |
| `compose/ProjectRows.tsx`, `compose/CompletionCard.tsx` | `oklch(0.55 0.13 hue)` | a project's identity dot, hue hashed from its name |
| `compose/AttachmentChip.tsx` | `DEFAULT_ACCENT`, sampled `rgb(...)` | an image chip's tint: the thumbnail's average colour |

CSS is not scanned: Vitest returns CSS imports empty even with `?raw` (PR 1's gotcha). The
stylesheets hold their colours in variables; a palette class can only enter CSS via
`@apply`, which nothing uses.

## Tone maps

- `components/pr/tones.ts` is the PR surfaces' one table: `toneText` (success, failure,
  pending, merged, draft, neutral, skipped), `toneBadge`, and new `prStateText` (open,
  merged, closed; keyed by `PrStateTone`). `prs/PrBits.tsx` (checks, review, state icon,
  freshness), `thread/HeaderActions.tsx` (single linked PR) and
  `overview/WorktreeOverview.tsx` (default-branch CI) read it; their copies are gone.
- Left where they are, each the only table for its own keys: `sidebar/SidebarRow.tsx`
  `toneClasses` (status line), `update/UpdateIndicator.tsx`, `agents/AgentsSurface.tsx`,
  `mcp/McpSurface.tsx`, `status/DaemonStatus.tsx`.
- Tone **names** still say colours (`"amber"`, `"emerald"`, `PrStateTone = "violet"`,
  `data-tone="amber"`). Renaming them is a refactor across `lib/session.ts`,
  `prs/prState.ts`, tests and e2e; not done here.

## Gotchas

- `color-mix()` with `var()` inside a custom property resolves where the property is
  used, so `.cf-thread { --t-red: var(--destructive) }` follows `.dark` on `<html>`
  without a dark override.
- Dedupe when collapsing pairs: `bg-info/10 hover:bg-info/15 dark:bg-info/10` must drop
  the `dark:` copy, but a `dark:` class with a different value
  (`dark:hover:bg-info/15` after `hover:bg-info/10`) stays.
- Hover states that moved a shade (`hover:text-emerald-500`, AgentsStrip's
  `hover:text-sky-700`) have no token step; they keep the base colour and the hover
  background carries the state.
- The isolated live copy's PR page is empty without a GitHub remote; a scratch repo with
  `origin` pointed at a real GitHub repo fills it (read-only).

## Verified

- `make check`.
- `make gui-e2e` (WebKit + Chromium): 760 passed, 40 skipped, 0 failed (the known `panel.spec.ts` Chromium flake did not show).
- Mock (Chromium, status-kinds world plus a workspace): start page, Pull Requests,
  Projects, worktree overview and a thread, dark and light, before and after, compared
  side by side and by sampled pixels: dark moves only at the former -300 sites (amber
  pending/stale text: 124,103,27 becomes 124,91,4 at the glyph edge), light where noted
  above; the thread's tones look the same in both.
- Live (`make gui-build`, isolated `CODE_FOUNDRY_HOME`, Haiku threads in a scratch repo):
  sidebar with needs-input, error, finished, working rows and a workspace chip; the
  Projects page (dirty count, workspace, member and branch icons); the Pull Requests page
  (pending and failing checks, open and merged icons), dark and light, before and after.
  `theme-2-palette/prs-dark.png`, `prs-light.png`, `projects-light.png`.
- Not seen live: the update chip (no update offered to a dev build), MCP and Agents
  panels; their classes are covered by the unit and e2e tests.

## PR 3 (tooltip sweep)

Every native `title=` becomes the shadcn `Tooltip`, none kept. Things this PR touched
that carry one: `prs/PrBits.tsx` (`ChecksBadge` label, `Age`, `Freshness` error),
`projects/WorktreeState.tsx` (dirty count), `sidebar/SidebarRow.tsx` (`row-moving`),
`status/DaemonStatus.tsx` (not streaming), `agents/AgentsSurface.tsx` (`agent-error`),
`overview/WorktreeOverview.tsx` (status and poll errors), `pr/PrMenu.tsx` (refresh hint),
`thread/UserBubble.tsx` (file tags). Tooltip colours must come from tokens too (the
guard will say so); `tip-status` in the sidebar tooltip already uses `toneClasses`.
