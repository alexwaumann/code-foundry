# Project pickers: a name match comes first

A user typed a project's name into the composer heading's project switcher and pressed Enter.
The workspace that contains that project was picked, not the project.

## What happened

The switcher (`ProjectSwitcher`) left filtering to cmdk and kept its two groups, Workspaces
then Projects. cmdk orders rows inside a group, the groups stay in place, and it highlights
the first row left on screen. A workspace row is found by its members' names, so typing
`beta` kept the workspace "demo (alpha, beta)" in the first group and highlighted it, above
the project named beta.

cmd+N's picker (`ProjectPicker`) already ranked one flat list itself (`rankPickerRows`) and
put the project first for this query, but only because cmdk's scorer happened to prefer the
shorter text; nothing said a name beats a keyword.

## Now

- `rankPickerRows` orders by how the query matches the row's own name first (`nameMatch`:
  the whole name, its start, the start of a later word, not at all), then by cmdk's score
  over the row's text, then the default order. A row found only by a keyword (a workspace by
  a member, a project by its path) comes after every row whose name matches.
- The switcher uses the same rows and ranking (`usePickerRows`, cmdk's filtering off). With
  no query it shows its groups as before. With a query it shows one list of the matches, best
  first, without the group headings, as cmd+N's picker does; the top row is highlighted, so
  Enter picks the best match.

## Decisions

- No headings while filtering. Keeping the groups would keep the problem: the best match can
  be in the second group while the first row on screen is in the first.
- A workspace still shows for a member's name. It is a fair thing to look for ("the workspace
  with beta in it"); it just no longer comes first.
- Words in a name split at anything that is not a letter or digit, so `my-beta` and
  `code foundry` match `beta` and `foundry` as words, and `alphabet` does not match `bet`.

## Tests

`useProjectRows.test.ts` (the ranking, as tables), `ProjectSwitcher.test.tsx` (a query lists
the project above its workspace with no headings and Enter picks it; clearing the query
brings the groups back; no match says so). No e2e: nothing here needs a browser.
