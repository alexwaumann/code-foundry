# Projects redesign 2: worktrees without threads

PR 3 of the Projects redesign (direction D, agreed 2026-10-31). PR 2
(`projects-redesign-1-index.md`) left a slot on the project page between Checkouts and
Details; this fills it. PR 4 rewrites the workspace page.

## What changed

- **Daemon**: `Worktree` on the wire carries `managed` (Code Foundry made it),
  `landed` (HEAD's work is in `status.base_ref`: no commits ahead, or a rebased or
  squash-merged copy landed; `project.Worktree.Landed`) and `cleanup_reason` (the
  `CleanupVerdict` reason beside `merged_clean`). `worktreeToProto` computes the verdict
  once for both. Table tests: `TestWorktreeLanded`, `TestWorktreeToProtoCleanupFacts`.
- **Leftover rule** (`lib/leftovers.ts isLeftover`): not main, and no thread that is not
  archived has it as its cwd or one of its checkouts. That is `threadHolds`, which now
  counts checkouts too, as the daemon's `cleanupHold` over `checkoutThreads` always did. So
  the index's "N worktrees to tidy", the project menu's Clean up merged worktrees (N) and
  the section's "Remove the N that are clean" are one number (`useCleanableCount`):
  `merged_clean` and nothing holds it. Every cleanable worktree is a leftover.
- **The section** (`components/projects/LeftoverWorktrees.tsx`): "Worktrees without threads
  · N kept", the bulk button (project.worktree.cleanup, hidden at 0), a row per leftover
  (dot amber while it holds work, grey when clean; branch; the reason; Show diff + Resume
  while it holds work, New thread when clean, Remove… on all, icon only when narrow), the
  footer sentence, or "Nothing kept. …". No disk size.
- **Reason sentence** (`leftoverReason`): "made outside Code Foundry" (managed false), then
  "3 commits not on main" (base_ahead while not landed), "4 uncommitted files" or "clean"
  when neither, "merged" / "merged otherwise" (landed, beside uncommitted files), "a
  terminal is open in it", "last thread archived 12d ago" (the newest archived thread whose
  cwd or checkout it was). A failed status read, an operation in progress or a detached HEAD
  shows the daemon's `cleanup_reason` as is (an unmanaged worktree's reason is "not a Code
  Foundry worktree", so those three are said in words there); no remote default branch
  says so.
- **Holding work** (`holdsWork`): uncommitted entries, or `landed` false (commits ahead, no
  base to compare with, a failed read). Clean = nothing uncommitted and landed.
- **Resume** (`projectActions.resumeWorktree`): the newest archived thread there is
  unarchived (thread.archive archived=false) and shown with its prompt focused; with none,
  the composer in that checkout (`composeIn(projectId, path)`). New thread is the composer.
- **Remove confirm** (`RemoveWorktreeDialog.tsx`, `stores/removeWorktree.ts`): registered as
  project.worktree.remove's confirm presenter, so the leftover rows and the checkout table's
  row menu (and anything else that passes the path) get "Remove the worktree on <branch>?",
  "<path> goes. The branch <branch> stays.", and while it has uncommitted entries "N
  uncommitted files are lost." with the first three uncommitted paths from the worktree's
  detail (the Changes tab's resource, `uncommitted` files) + "and N more · Show diff".
  `removeWorktree` now passes `path` as an arg so the presenter knows the worktree. Without
  a path (the palette, context only) or with delete-branch/force the generic confirm asks
  in the daemon's words.
- **Details' Worktrees row**: "<shared dir> · 5, 3 made by Code Foundry" ("· 1 made by Code
  Foundry" when it made them all, the bare count when none).

## Decisions and gotchas

- **One yes for dirty work.** git refuses a dirty worktree; the daemon then raises a
  second-stage confirmation carrying force. The command store gained
  `registerSecondStagePresenter`: a yes in the remove dialog while it showed the loss is
  remembered for that path and answers the second stage (force) without asking again. If
  the files appeared after the dialog opened, the dialog opens again, now with the
  warning. Holds are checked before git runs, so a second stage means nothing held it;
  force is never sent on the first try.
- `managed`, `landed` and `cleanup_reason` are optional in `WorktreeView` (absent: false /
  empty), so fixtures elsewhere did not change; an older daemon reads as unmanaged and not
  landed (amber, "made outside Code Foundry").
- The checkout table's row menu still offers Remove worktree… on a checkout a thread is on;
  the daemon refuses it ("in use") as before.
- Mock: `POST /__mock/leftovers?project=repo-cf[&clean=1]` seeds cf/perf-spike (3 commits
  not in origin/main, thread archived 12d ago), cf/old-copy (4 uncommitted files, landed,
  thread archived 3w ago, detail with four uncommitted files), exp/shaders (outside the
  app's worktrees directory: unmanaged, clean, merged) and with clean=1 cf/usage-polish
  (cleanable). `MockWorktree.managed` overrides the by-path rule; the mock's
  project.worktree.remove raises the second stage (force) for a dirty worktree like the
  daemon. The mock's cleanup reasons come from `verdictReason`.
- The default mock world has no leftovers (threads hold both code-foundry worktrees), so
  "Nothing kept" is what most specs see.

e2e: `projects.spec.ts` (rows, reasons, actions, Show diff, Resume both ways, New thread,
narrow Remove, the three counts, the confirm with and without the warning and its Show
diff, one-yes dirty removal with force, bulk remove, nothing kept, section order),
`sidebar.spec.ts` (the checkout menu's Remove worktree… through the new dialog). Unit:
`lib/leftovers.test.ts`, `lib/projects.test.ts` (holds by checkout, made-by count),
`stores/removeWorktree.test.ts` (presenter, second stage, fallback).
