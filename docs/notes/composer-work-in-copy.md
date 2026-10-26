# Composer: thread width, Work in titles, name-only chips

Feedback on the new-thread composer (a user, 2026-10-26).

## What changed

- **Width.** The composer body uses the thread column's width instead of its own
  `max-w-2xl`. The `--thread-col` / `--thread-dock` variables moved from `.cf-thread` to
  `html` (same `html[data-thread-width]` variants), and `.cf-thread-col` in `thread.css`
  shares `.cf-thread .col`'s width and 40px side padding (not its margin: the composer's
  `m-auto` keeps it centred both ways, and a `margin: 0 auto` in the class pinned it to the
  top). The composer's section keeps its vertical padding only. Nothing else reads the
  variables.
- **Work in titles.** The pill and its option in the picker say the same thing: "Fresh copy"
  / "Project folder" for one project, "Fresh copies" / "Project folders" for a set of more
  than one (a workspace with one member is singular). The option tags ("new worktree",
  "in place", "no git", the main branch) are gone: the branch indicator beside the pill
  already shows the checkout's branch. The titles live in `lib/compose.ts` (`FRESH_COPY`…)
  so `workInText` and the picker cannot drift.
- **Fresh copy detail.** Set: "Edits land in a new branch with a worktree for every
  project. Multiple threads at a time is safe." (the "folders are shared" clause is gone:
  whether a plain folder is in the set is the collision hint's business, not the option's).
  One project: "Edits land in a new branch with its own worktree. Multiple threads at a
  time is safe." Project folder details are unchanged.
- The picker's footer ("Default for new threads: Settings › Threads › New threads work
  in") is gone; `ComposerPicker` keeps the `footer` prop.
- **Chips.** A project chip is the project's name alone: no branch (it depends on the
  setting and the pick, and the Work in pill says it), no No git badge (the note under the
  picker says it), no path tooltip, no primary highlight or dot (the Runs in picker shows
  and picks the primary). `data-primary` is gone with it; the × to remove stays.
  `MemberChipModel` is `{ projectId, removable }`; `projectChipBranch` and `NEW_BRANCH`
  left `lib/compose.ts`.
- The read-only pill of "New thread on this branch" in place says "Project folder(s)" too.

## Not changed

- `threads.default_worktree`'s labels in Settings ("A fresh copy of the project" / "The
  project folder itself") and its description: the setting reads as a sentence there.
- The like-draft worktree-mode pill ("On feat/x", "Its worktrees").

## Gotchas

- `composer-files.spec.ts`'s zoomed file-card cases failed while the composer was pinned
  to the top (see Width): the completion list had room for all of its rows at 125% and the
  "capped to whole rows" branch never ran. With the body centred again they pass unchanged.
- `live-workspace.spec.ts` clicked the second chip's first button to make it primary. That
  button had been the × for a while; it now uses the Runs in picker.
