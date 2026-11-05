# Picker hover guard

A user typing in the palette with the mouse resting over the list saw the selection land
on rows 46, 19 and 8 instead of the first row, and the Previous prompts card jump away from
the row Up had wrapped to.

## Decisions

- `lib/pointerMotion.ts` decides whether a pointermove is real, by comparing the position
  with the last event's. WebKit's synthetic event after a layout change repeats the position
  exactly and is trusted, so `isTrusted` is no help; `movementX/Y` is 0 for real moves too in
  the app's WebKit.
- The position is tracked on the window, not per list. No event fires when a list opens, so
  the synthetic one can be the first a list ever sees: a per-list baseline would either take
  it for a move, or swallow the first real one (a single hover would then select nothing).
- `Command` (`components/ui/command.tsx`) stops resting events in the capture phase, so every
  cmdk picker gets it. `PromptHistoryCard` asks `pointerMoved()` in its row handler (now
  pointermove, so it reads the event the tracker just saw).
- `CommandList` scrolls to the top on a new search, reading `search` from cmdk's store so
  controlled and uncontrolled inputs both count. `ProjectPicker` scrolls an inner element,
  marked `data-command-scroll`.
- `useFirstRowSelection` (FileFinder's rule, moved) serves PromptsPicker too.

## Gotchas

- cmdk's scheduler adds its scroll to the Map it is iterating, so the scroll runs in the same
  pass as the first-row pick, before that selection renders. It scrolls to the old selected
  row, wherever the new list put it. That is why the list stayed at 1216 with row 0 selected,
  and why the reset is a passive effect: a layout effect in the list runs before the root's.
- cmdk's row cleanup looks for the selected row after it has left the DOM, so a list whose
  rows arrive after the search can end with nothing selected. PromptsPicker did (Enter did
  nothing), and kept a surviving row selected when a filter widened.

## Measured in WebKit

Pointer at rest over the list, keys moved off row 0, then characters typed: CommandPalette,
its arg prompts, ProjectPicker, FileFinder, PromptsPicker (also deleting), RunInPicker on a
nine-project thread, ReviewerPicker (also deleting and cached terms), ProjectSwitcher,
ComposerPicker's Work in, LocalFolderTab. Not measured: MovePicker (same uncontrolled
`Command` as RunInPicker) and ComposerPicker's Branch from, which the mock's project did not
show.

First row means the first one cmdk can select: RunInPicker skips the disabled current
checkout, ComposerPicker's Work in the fixed rows above its filter, and LocalFolderTab's is
the hidden row for the typed path.

## Same pattern, not changed

`CompletionCard` (mousemove), `SearchList`, `RecentSearches` and `AgentParts` (pointermove)
select on hover without the guard. They are not cmdk and were outside this change;
`pointerMoved()` is what they would call.
