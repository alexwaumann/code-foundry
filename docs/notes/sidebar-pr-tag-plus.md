# Sidebar PR tag: +N in the worst state, no tooltip; the hover card opens at once

GUI only. Three asks from Alex (2026-10-31), one PR.

## What changed

| Path | What |
|---|---|
| `gui/frontend/src/components/sidebar/linkedPrTag.ts` | `many` is now `{ lead, state, count, tone }`; `linkedPrTip` and `linkedPrStateLabel` removed |
| `gui/frontend/src/components/sidebar/LinkedPrsBadge.tsx` | no `Tip`; `data-quiet`; the click opens every counted PR as a panel tab and reads each detail once |
| `gui/frontend/src/components/sidebar/SidebarRow.tsx` | the hover card's `delayDuration` is 0; it stays shut over `[data-tip]` and `[data-quiet]`, and reopens when the pointer comes back off one |
| `gui/frontend/e2e/linkedprs.spec.ts` | the new texts, no tag tooltip, the panel tabs |

## Behaviour

* Several linked pull requests look like one PR: the worst state's icon and colour and
  "+N", N all the counted ones ("+3"), no number. The worst state is the old rule
  unchanged: any draft, then any open, then merged when all are; unknown ones count, and
  merged plus unknown is unknown (neutral). A first build showed the leading PR's number
  before the +N; Alex asked for the count alone.
* The tag has no tooltip, and the row's hover card does not open over it (`data-quiet`,
  beside `data-tip` in the row's quiet selector). Click only: one PR opens its PR tab;
  several open one tab each, the lead (the newest in the worst state) last so it is active.
* The hover card opens at once (`delayDuration={0}` on the row's Tooltip; the app root's
  500 ms stays for everything else).

## Gotchas

* Radix opens a tooltip on a pointer move once per visit of its trigger. The first move
  over the tag is refused (quiet), so coming back onto the row's name would not reopen
  the card until the pointer left the row. `onPointerOver` now opens it when
  `relatedTarget` is a quiet element inside the row.
* Only the active PR tab reads its detail. The old click showed the thread info card,
  which read every linked PR's detail, and that is how a closed PR left the count. The
  click now does `pullRequestDetailResource.watch(key)()` per counted PR: the fetch runs
  (the resource does not abort on release) and the entry stays.
* Which PR leads (the active tab) depends on what the GUI knows: a linked PR on no
  dashboard is unknown, so an open one linked earlier leads over it.
