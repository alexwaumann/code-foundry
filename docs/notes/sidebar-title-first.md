# Sidebar rows, title first

The sidebar's thread rows lead with the thread's name. Agreed after three rounds of sketches
drawn inside the real app (mock daemon, the theme's tokens and type roles).

## The row

- **Line 1**: the name (text-body, medium) and the status as its icon alone, in its tone. Working,
  waiting and setting up add their time; an idle thread shows only the time since its last
  activity, muted. The word (Permission, Question, Done, a plugin's name…) is on the hover card;
  the row keeps it as `sr-only` text for screen readers.
- **Line 2**: the project's kind glyph (`ProjectKindIcon`, the Projects page's: the GitHub mark,
  the git folder, the plain folder), Layers for a workspace thread, House for no project; then
  the project. The counts (live subagents and children, shells) and the PR tag on the right.
- **Line 3**: always the branch. The status's detail (the tool a turn runs, the question, the
  error, the setup step) and a queued Run in move no longer replace it: the line was too easy to
  click past for its text to be useful there. The hover card carries all of them.
- **Pins**: a muted pin glyph before the name (where ↳ goes for a thread an agent made). No
  divider and no Pinned label.
- **Hover**: Snooze and Archive sit on the right of the row's last line (the branch line, or the
  project line on a two-line row, where they take the counts' place). The name and status never
  move or hide on hover; on a three-line row the counts and PR tag stay clickable.

## Two-line rows

A thread without a project or without git has no branch line, so its row is `TWO_LINE_ROW` (44px:
22 + 16 + 3 above and below) instead of `THREE_LINE_ROW` (60). The No git chip is gone from the
row: the missing branch says it (the card keeps its "no git" chip).

The rule is `rowHasBranchLine` (`components/thread/useThreadPlace.ts`): a project with git, whether
or not the branch is known yet. A thread being set up names its branch a moment after it appears;
keying the height on the branch itself would grow every new row from two lines to three.

## Gotchas

- Row height now depends on the thread, not only the section. `PanelRows` reads
  `useBranchlessRows(ids)`: one string of the branchless thread ids, so a change re-measures the
  virtualizer only when a row actually gains or loses its branch line. The selector compares
  place inputs as JSON strings: an array of fresh objects under `useShallow` would never settle.
- `row-line-1/2/3` now mean name, project, branch. `row-detail` and `row-moving` are gone;
  `statusDetail` stays for the hover card.
