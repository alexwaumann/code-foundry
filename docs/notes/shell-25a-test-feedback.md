# Shell 25a: the owner's test feedback

The owner tested the `shell` branch and decided nine changes. Each changed agreed behaviour, so
`shell-model.md` was edited first (one commit), then each was built.

## 1. Thread info per thread

- The choice lives in the daemon's layout, `ThreadState.Info` (`*bool`; nil: never toggled), set
  by a new op `set_info` and stored in the thread's row document (`ThreadDoc.info`), so it follows
  the thread across panes, spaces and restarts. The layout's thread state was the natural home: it
  already holds what follows a thread (its space, quick terminal, remembered set) and reaches every
  window through the layout event.
- A new verb, `thread.info [id] [--open|--close]` (default: toggle), sets it. `view.thread-info`
  (cmd+shift+i and the header's button) stays the user's key: it reaches the window, which alone
  knows whether the pane has room for the card. With room it runs `thread.info` for the focused
  thread with `--open` or `--close`; without, it shows or hides the temporary overlay as before,
  and showing the overlay turns that thread's card on.
- The setting `layout.thread_info` (Appearance › Panes and sidebar, on by default) is the choice of
  a thread never toggled. `thread.info`'s toggle reads it through the settings service (the
  command package cannot import the settings store: the store imports it).
- The window-wide `threadInfoOpen` in the UI store is gone; an old saved value is ignored.
- Archiving a thread forgets its layout record, the info choice with it; unarchived, it follows the
  setting again. Kept that way: archiving already forgets the rest of a thread's layout.
- Gotcha: the layout store writes each thread as its own row with a document of named fields, not
  the whole `ThreadState`; the first version lost the choice on a daemon restart. Found by running
  it on a scratch daemon; the store's reload test now covers it.

## 2. Edge drop zones

Each edge zone over a pane's body is a third of the body (`EDGE_SHARE = 1/3`), capped at 320 px
across and 260 px down (`EDGE_MAX`); the middle third adds to the pane. The grid's outer band
(`OUTER_IN`, `OUTER_OUT`) and the narrow-body rule (`EDGE_MIN`) are unchanged.

## 3. Focused pane

The focused pane's border is `border-cf-accent/60` (the theme's accent at 60%), the others keep
`border-cf-divider`. A Tailwind opacity on the existing token rather than a new theme slot: it
follows every theme, dark and light, with nothing to derive.

## 4. The floating composer's chip

The collapsed pill and the expanded chip are one button (`FloatingChip`, test ids
`floating-composer-pill` and `floating-composer-chip` by state, `aria-expanded`). A press captures
the pointer; once it moves 3 px it drags (in either state) and its click is swallowed, so a drag
never toggles. The collapse icon button and its tooltip are gone. The press does not take the
keyboard (`preventDefault` on pointerdown), so dragging the expanded card leaves the prompt focused.

## 5 and 6. One fold rule

Reproduced in `rails.test.ts` with the owner's layout at the window's minimum width (grid 644 px
wide: 940 less the 260 sidebar and three gaps). The cause: a fold was kept only when it shrank the
tree's minimum on its own, and folding one pane of a column never narrows the column (the other
pane still needs its width). With the diff focused, the diff's pane and its thread's pane never
fold, the only panes left were the draft and the thread of the middle column, neither helped alone,
so nothing folded and `frameRects` shared the row by size: the middle column at 204 px. With Pull
Requests focused only the focused pane was kept, so the left thread could fold and looked right
(its middle column was still drawn below 360, which the photo hides).

The rule now (`foldRails`): panes fold in the fold order until the tree fits, whether or not a fold
helps alone; then the folded ones, last first, unfold where the tree still fits. When even the
panes that never fold cannot keep their minimums, a pane unfolds only when that runs no further
past the area and every open pane that may fold still gets its minimum; the panes that never fold
share what is left in proportion to their minimums (`lengths` in `rects.ts`, previously by their
sizes), so each falls short by the same fraction. At the minimum width with the diff focused the
middle column folds whole and the thread and the diff take 339 and 245 px (about 6% short).

The same change is item 6: a row only gets shorter once all its panes fold, so a short row never
folded before. `PaneRail` already drew a fold in a column as a horizontal strip (orientation by its
rectangle), and `RAIL` already applied to both directions; nothing else was missing. A seeded fuzz
of 300 trees now also checks that only a pane that never folds is ever drawn short, and that then
no other fold would help.

The PRs-focused case changes too: the middle column folds along with the left thread, since the
left thread plus the middle column at 360 cannot fit 644 px with Pull Requests' 300.

## 7. Woken threads

A thread woken from a snooze ("snooze ended") is marked `woke` in the sidebar's list key. It is no
longer in Needs you or its numbers (the section, the space tabs, the top bar's control,
cmd+shift+a); it sits at the top of Active below the pinned threads and the drafts, most recently
woken first, keeping its Woke status until opened. A pinned woken thread stays with the pinned.

Needs you still holds, besides permissions, questions and plans: a folder trust dialog
("trust: …"), a terminal notification or bell ("notification: …", "bell"), a Claude API error at
the prompt ("error: <code>" as an attention status), any other attention reason ("blocked: …",
"continue: …", "menu: …" and unknown ones), and a plugin's attention flag. Left as they were, for
the owner to decide; the specification says so.

## 8. Collapsed sidebar

The Needs you control now comes after back and forward in the top bar.

## 9. Draft rows

A draft row sits on `bg-cf-warning-surface` (the warning tone at 10%), `bg-cf-warning/15` on hover
and `bg-cf-warning/20` when its tab is focused; Discard is unchanged.

## Tests

- Go: the `set_info` JSON cases (shared with the mock), `thread.info` (toggle by the setting,
  open, close, refusals), the store's reload, the thread document's round trip.
- vitest: the owner's layout in three focus cases, a short row, the fuzz's new invariants, edge
  zones, the focused border, the top bar's order, draft tints, woken threads in the sections and
  the list keys, the per-thread info hook and toggle, the chip as one button.
- e2e (`shell-feedback.spec.ts`): the owner's layout at the minimum width in WebKit, a short row as
  strips, and SHOTS for every item; `shell-fullscreen.spec.ts`'s drag test now drags the pill too
  and checks a drag does not toggle.
- The card on by default changed ten e2e specs' setup: those of the card (they show it with its
  toggle) and those of the conversation measured without it (`thread`, `thread-prompts`,
  `thread-message-fold`, `page-library`). They start with `infoCardOff()` (e2e/fixtures.ts:
  `layout.thread_info` off), the state they were written for. With the card shown, a turn
  header's fold moved the header by 15 px in `thread.spec.ts`'s fold test; that may predate this
  change for anyone who had the card on, and is left for a separate look.
- End to end: `thread.info` on a scratch daemon and the CLI, toggled from the setting's default,
  set explicitly, shown by `layout show`, kept across a daemon restart.
