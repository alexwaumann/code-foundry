# Sidebar: New thread as a nav row

> New thread (`thread.new`) was the sidebar's one filled accent button, full width under
> the toolbar with its chord as a hint. A user found it too loud: it is pressed a few times
> a day, while the sidebar's job is to show which thread needs input. It is now the first
> row of the nav group above Pull Requests and Projects, drawn exactly like them.

## Decisions

* **Same row as the other nav entries.** 28px (`h-7`), `text-body-sm`, a 16px lucide
  `Plus` in `text-cf-icon-muted`, the sidebar rows' hover. It keeps `CommandButton`
  (ghost variant, classes overriding the ghost hover and the button's `text-label`
  weight) so availability (`whenUnavailable="disable"`) and the keep-focus behaviour are
  unchanged.
* **No chord hint.** The `⌘N` chip is gone with the button; the palette and the help page
  show chords. `e2e/layout.spec.ts` now asserts no `<kbd>` on the fresh app at all.
* **One group.** Pull Requests had the group's `mt-1.5`; it now has the rows' `mt-0.5`
  like Projects, so the three rows sit 2px apart and New thread carries the group's gap
  from the toolbar (or from Ember's pinned row when Ember is on).
* **Rejected.** Keeping the chord chip (muted) on the row: fine, but the row then has the
  only key chip in the sidebar and the hint has a home already. A blue plus on the row:
  in dark mode it is the only coloured glyph in the group and draws the eye again.
* **Dashboard's New thread button is unchanged.** It is the page's primary action, not a
  nav entry.

## Verification

`make check`; `e2e/layout.spec.ts`, `buttons.spec.ts`, `ember.spec.ts` against the mock;
dark and light screenshots in the PR body.
