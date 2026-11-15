# Preview tabs, PR 3: the GUI

The last of three pull requests for preview tabs (`docs/notes/shell-model.md`, "Preview tabs";
PR 1 `preview-tabs-1-daemon.md`, PR 2 `preview-tabs-2-row-drag.md`). The daemon already had
everything; this makes previews visible and usable in the window. The only rules in the window
are which clicks ask for a preview and which user actions send `tab.keep`; one preview per space,
replacement and every other keep stay the daemon's.

## What is in it

| File | Holds |
| --- | --- |
| `stores/ui.ts`, `stores/selectionBridge.ts` | `SelectOptions.preview`: the bridge's `thread.open` gets `--preview` |
| `stores/flagSurface.ts` | `selectThreadAndFlag(id, { preview })`: a preview open opens no flag surface |
| `components/sidebar/shell/ShellSidebarList.tsx` | `activate`: an Archived or Snoozed row (click, Enter, Space) asks for a preview |
| `shell/preview.ts` | `previewTabOf`, `usePreviewTabOf`, `keepPreviewTab` (tab.keep on a preview only), `useKeepPreviewOnDraft` |
| `components/shell/PaneTabStrip.tsx` | `PREVIEW_DASHES`, `data-preview`, ", preview" for a screen reader, double click keeps |
| `components/shell/PaneRail.tsx` | the same dashes around the icon, `aria-label` "<name>, preview", double click keeps |
| `components/thread/ThreadHeader.tsx` | "Keep open" first in the three-dot menu, for a preview only |
| `components/thread/ThreadComposer.tsx` | `useKeepPreviewOnDraft(threadId)` |
| `mock/world.ts`, `mock/layout.ts` | the daemon's glue: unarchive, wake, rename, pin keep a preview; a wake clears the snoozed mark |
| `e2e/shell-preview-tabs.spec.ts` | three archived clicks, one preview; computed dashes in both themes; no shift on keep; SHOTS |

## Decisions

- **The click goes through the selection bridge.** A row click is `select()`, which the bridge
  turns into `thread.open`; the option rides along as `preview`, so the click still runs the verb
  (with `--focus`) and never the raw layout op, which has no preview field. A drop is untouched
  (`shell/drag/threadDrop.ts`): it is an open at a place, always kept.
- **No flag surface on a preview open.** Opening a plugin's surface for the thread is one of the
  daemon's keeps, so it would keep the preview at once. Active rows still open theirs.
- **The dashes are an overlay.** `after:absolute after:inset-0 after:border after:border-dashed
  after:rounded-md`: a pseudo-element over the tab's box, so neither the tab's width nor the
  hidden measure row (`shell/geometry/tabFit`) changes, and the tab's fills show inside unchanged.
  The rail uses `after:` too, since its accent bar is `before:`. The colour is
  `cf-text-muted` at 60%: a quiet neutral that reads on both themes' surfaces (the theme's
  `border-strong`, text at 16 to 18%, was too faint for a 1px dash). Not the accent, not the
  focus ring.
- **The thread icon is the surface's**, unchanged; the name is upright.
- **"Keep open" is in the thread header's menu**, first, followed by a separator. Thread tabs have
  no context menu (only terminal tabs do), so the brief's fallback applies. Its tab is the
  pane's active tab when that is this thread's preview.
- **Double click.** A double click on a tab or a rail icon did nothing before (the first click
  focuses, the second found the tab focused). Now it keeps a preview; on a kept tab it still does
  nothing. On a rail the first click unfolds the pane, so the second may land on the strip's tab
  instead, which keeps it the same way.
- **Typing keeps on a change, once.** `useKeepPreviewOnDraft` watches the thread's draft (text and
  attachment count). It keeps when the draft changes and then holds non-blank text or an
  attachment: typing, a paste, a dictation result, a dropped file. A draft that was already there
  when the composer mounted keeps nothing until it changes (an old draft is not the user writing
  to this preview). Each preview tab id is asked once, so later keys send nothing even before
  the commit lands; a new preview of the same thread is a new id and is asked again.
- **Reading keeps nothing**: focus, scroll, select, copy, find and the info toggle send no
  `tab.keep` (they do not change the draft or call the helpers).

## The mock

The mock's world now does what the daemon's glue does for previews (`World.layoutGlue`, run from
`publishThread`): it remembers each thread's archived, snoozed, pinned and name; on a change to
unarchived, woken, renamed or pinned it keeps the thread's preview tab, and a wake clears the
layout's snoozed mark (`MockLayout.threadChanged`, not an op, so the case runner's ported-op list
is unchanged). It does not bring a snoozed thread's set back on a wake: the mock's open never held
it back.

## Verification

- vitest: `ShellSidebarList.test.tsx` (click and keyboard on Archived and Snoozed rows run
  `thread.open --preview`; an active row's does not), `selectionBridge.test.ts`,
  `flagSurface.test.ts`, `PaneTabStrip.test.tsx` (the dashes in each state with that state's fill;
  the ordinary icon; the screen reader's ", preview"; the measure row unchanged; double click keeps
  once and only a preview; a click and focus keep nothing), `PaneRail.test.tsx`,
  `linkedTabs.test.tsx` (the header menu's Keep open), `shell/preview.test.tsx` (the draft keep),
  `mock/world.test.ts` (the glue).
- e2e `shell-preview-tabs.spec.ts` (WebKit, mock).

## Gotchas

- `getByText` on a tab's name finds two elements: the hidden measure row draws every tab again.
- The mock world lists one archived thread in the sidebar (s-7); the e2e archives two more with
  `POST /__mock/thread/archive`.
