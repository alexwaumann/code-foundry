# Thread info card: project set picker fixes

Status: done on branch `cf/thread-project-picker-fixes` (one PR, GUI only). Follows
`thread-project-set.md` (#418) after a user's report on the project row's menu.

## What was wrong

* **The × on a Run in row also ran the thread there.** The button stopped `pointerdown`
  from reaching the Radix menu item but not `pointerup`; Radix selects an item on a
  pointer up it saw no pointer down for (`event.currentTarget.click()`), so one click fired
  `thread.run-in` and `thread.project.remove`. On an idle thread the move is immediate and
  the remove was then refused ("is where the thread runs"), which read as "removing makes
  it the cwd and fails". The daemon never changes the cwd on an add; the switch the user
  saw was this.
* **Save as workspace disabled with two projects, enabled with three.** It is disabled
  whenever a saved workspace already has exactly the set, with no hint why and no way to
  follow that workspace again: a thread that leaves a two-project workspace for a third
  project and drops it again lands there.
* **The multi-select Add project list** hid the worktree creation behind a check that
  appeared late, and a user adds one project at a time anyway.

## Decisions (aligned with the user, 2026-10-31)

* The × stops `pointerup` too, and says "Remove project" on hover (a tooltip for an icon
  with no label, as the user asked). It still never shows on the cwd's row, which is also
  what keeps a thread from losing its last project: the cwd is always a member, and the
  daemon refuses to remove it.
* Add project is a single pick: the list holds only the projects not in the set, closes on
  the pick, and the project row's meta reads "Adding <name>…" with a spinner until the
  daemon answers (`stores/threadProjects.ts` `useAddingProject`, set around the command).
  With every project in, the list says "Every project is in this thread." The filter box
  stays (the picker is the composer's, and multi-select may come back if users want it).
* An unnamed set of two or more offers **Use workspace <name>** (`thread.workspace`) when a
  saved workspace has exactly the set (`stores/saveWorkspace.ts` `useMatchingWorkspace`),
  else **Save as workspace**. An explicit item, not a silent re-attach: the menu reports
  what it does, and a set may equal a workspace the user never meant to follow.
* No workspace row for an unnamed set is the intended look (crumb and row read "web +1").

## Gotchas

* Playwright WebKit dismisses the anchored picker popover right after a `page.screenshot`
  that follows another screenshot in the same session; the real app and a single probe do
  not. Scratch scripts reopened it when needed. Not an app bug.
* The e2e mock has five projects, so a "every project is in" check needs three adds from a
  two-project thread.

## Tests

* `e2e/thread-project-set.spec.ts`: single pick closes the list and members are not
  offered, the empty-list line, Use workspace replaces Save when the set matches (and
  attaches the thread), the ×'s tooltip and no `thread.run-in` from it.

## Verified

* `make check` green; the two card specs on WebKit.
* Scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cf-pset2`, repos web/api/lib, workspace
  platform = web+api) with the dev frontend: add through the card keeps the cwd; the ×
  removes without moving the thread (before the fix it moved it, log "thread moved to
  another checkout"); Use workspace platform set the reference; shots in the PR body.
