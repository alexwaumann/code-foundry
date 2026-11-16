# The current space's tab is a solid accent pill

A user could not tell at a glance which space the window showed: the current tab was a bordered
pill one step lighter than the top bar.

## Decisions

- The current tab is filled with the theme's accent (`bg-cf-accent`, `text-cf-accent-foreground`,
  medium weight), the same pair the primary buttons use, so it follows a user's own theme. Its
  layout glyph's panes are tinted (`SpaceIcon filled`).
- No colour per space. Users make their own themes and the app should not put colours on top of
  them; a space is told apart by its name and its glyph.
- Switching a space stays instant. Nothing in the tabs animates and the panes do not slide: it is
  done many times a day and an animation there gets in the way. A sliding pill, a slide of the
  panes and a name flash were tried in a prototype and dropped.
- The count of threads that need the user keeps the warning tint on the other tabs. On the current
  tab that tint does not read on the accent, so it takes the tab's own foreground at 20%.

## Gotchas

- While a tab or pane is dragged over the current space's tab, the drop mark wins over the fill
  and the count goes back to the warning tint (`current && !dropping`).
- The medium weight makes the current tab a pixel or two wider than the same tab when it is not
  current, so the tabs after it move by that much on a switch.
