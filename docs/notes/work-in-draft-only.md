# Work in: a pick applies to its draft only

## What changed

- The composer no longer remembers a Work in pick per project. `stores/workIn.ts`
  (localStorage `code-foundry.workIn`) is gone, with `workInMemory` and the memory input of
  `defaultWorktree`.
- A project draft's worktree resolves as: the draft's own pick (`Draft.worktree`), else
  `threads.default_worktree`, else the project folder itself. "In place" still falls back
  to a fresh copy while the main checkout is unknown.
- The picker's onChange is a plain draft update; `pickWorktree` is removed. The footer
  "Default for new threads: Settings › Threads › New threads work in" is unchanged and is
  now always true.
- docs/GETTING-STARTED.md (and so the help skill's bundled copy) says a choice applies to
  that thread only. The settings schema comment says the same.

## Decision and why

The setting is the one default for threads a user starts from the composer (Alex,
2026-10-22). The remembered pick silently shadowed it with no visible sign, the daemon
could not see it (so the model could not explain or change it), and the footer pointing at
Settings was false once a pick had been made. Threads the model starts with `thread new`
are a separate change.

## Gotchas

- The stale `code-foundry.workIn` key is left in localStorage. Each persisted store sets
  itself up in its own module and nothing removes retired keys, so there was no natural
  one-line place; the key is a few bytes and nothing reads it.
- Historical notes (onboarding-3-work-in.md, new-defaults.md) describe the memory as it
  was and stay unchanged.

## Verified with

- Unit: lib/compose.test.ts `defaultWorktree` table, stores/compose.test.ts (setting
  table; a pick applies to its draft, the next draft starts from the setting).
- e2e: compose.spec.ts "Work in: … a pick applies to its draft only" (pick Fresh copy,
  send, the next code-foundry draft and one after a reload read In place).
- `make check`, `make gui-e2e`, `make gui-build`.
