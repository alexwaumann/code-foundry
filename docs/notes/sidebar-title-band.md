# Sidebar title band

Decided 2026-10-10 (Alex), from a rendered HTML mockup (current vs proposed band at 260px,
and proposed with the attention badge at the old 180px minimum). Frontend only; no Go or
proto changes, no daemon restart.

## What changed

* **The app name replaces the section label.** `SidebarBand` (components/sidebar/Sidebar.tsx)
  shows "Code Foundry" as a `span` (`sidebar-app-name`): 13px, semibold, `leading-none`,
  `tracking-tight`, `text-sidebar-foreground` (as SidebarRow), `select-none`, truncating.
  It is not a heading because every content-pane page has its own `h1`. The old uppercase, muted, 11px "Threads"
  label is gone. The list's own "Threads" section row still labels the threads. The
  header's left padding after the 80px traffic-light gutter is 12px (`pl-3`), right 12px.
  The band is still `TITLE_BAND_HEIGHT` (52px) and the drag split is unchanged: the band
  drags, `sidebar-band-controls` is `no-drag`.
* **No New terminal button in the band.** `terminal.new` itself is unchanged: it is still
  in the registry, the palette, cmd+T, the row menu ("New terminal here"), the welcome
  panel and the Projects page. With a thread selected, the palette still runs it in that
  thread's worktree (context-bound `cwd`). buttons.spec covers that path now, replacing
  the e2e that clicked the band button.
* **New thread uses lucide's `SquarePen`** instead of `Sparkles` (`sidebar-new-session`,
  `session.new`). Only the band changed: the welcome panel and the Projects page still
  use `Sparkles` for New thread.
* **The attention badge sets its own 11px size.** It used to inherit 11px from the
  uppercase header and undo the header's case and tracking with `normal-case
  tracking-normal`. The header has neither now, so those classes are gone.
* **`SIDEBAR_MIN` is 220 (was 180).** At 180 the gutter (80) + paddings (24) + gap (8) +
  badge, gap and button (about 65 after the button's `-mr-1.5`) left the name about 3px:
  the mockup showed it squeezed out completely.

## Gotchas

* **220 keeps the name visible, but not always whole.** "Code Foundry" is about 85px wide.
  Without the badge it fits from 215px. With a one-digit badge the whole name needs about
  263px. So at 220 with the badge it reads "Cod…", and at the 260px default with the
  badge it is about 2px short ("Code Foun…"). Each extra badge digit costs about 7px. A
  wider minimum (about 264) or default (about 280) would fix that if it matters.
* **Saved sidebar widths are clamped on load.** The ui store's persist `merge` clamps
  `sidebarWidth` to [SIDEBAR_MIN, SIDEBAR_MAX], so a width saved under the old 180
  minimum loads as 220. It is a clamp, not a migration (the persist version stays 3).
  `SIDEBAR_DEFAULT` (260) is the initial width and what double-clicking the resize handle
  restores.
