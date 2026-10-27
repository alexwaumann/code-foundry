# Composer collision banner

The new-thread composer's muted list of collision hints under the chips is replaced by one
amber banner above the card, an amber warning on the Work in pill, and the same warning on
each colliding project's chip. GUI only; the daemon and its after-create hints are unchanged.

## What counts

A thread collides only while it is running: `lib/thread.ts isRunningThread` (not archived,
not snoozed with a wake time still ahead, state `connected` or `starting`). Stopped,
closing and snoozed threads edit nothing until they are sent to again. The checkout
matching is the existing `lib/collisionHints` rule (by checkout path).

The rule runs inside the threads-store selector of `useCollisions` (renamed from
`useCollisionHints`): only running threads produce a key, and each key carries the
working flag (`isWorkingThread`, the row's busy badge). A thread that starts, stops, is
snoozed, archived, or goes busy/idle changes the key list, so the hook recomputes; other
store churn does not.

`isRunningThread` lives in `lib/thread.ts`, not `lib/collisionHints.ts`, because the mock
daemon (`mock/projectSets.ts`, the node tsconfig without the `@/` alias) imports
`lib/collisionHints` and must not pull in `@/api/threads`.

## Wording (`collisionBanner`, `COLLISION_DETAIL`, `collisionTip`)

- Several projects in the draft: "2 of 3 projects are already being edited on `main` by
  another running thread." (x = colliding projects, y = projects in the set; "1 of 2
  projects is ..." singular.)
- One project: "This project is already being edited on `main` by another running thread."
- Colliding projects on different branches: "on their branches". A plain folder (no
  branch) among them: the "on ..." is left out.
- Then, muted: "Multiple agents changing the same file at the same time can overwrite each
  other's work."
- Tooltip line per colliding project (Work in pill: all; chip: its own):
  "<project> · <branch> is open in **<thread>** (working | idle)"; a folder has no "· branch".

## Behaviour

- Exactly one banner, never a list. "Use a new branch" sets the draft's Work in to the
  `new` choice; it is hidden for a like draft (its mode is its thread's), a draft without
  git, and a draft already on a new branch. A new branch collides with nothing except a
  plain folder in the set, which is the one case where the banner shows without the button.
- The daemon's after-create toast is unchanged. The composer still passes its lines (now
  `hintLine` over the banner's collisions) to `sendDraft`, so the toast does not repeat
  them; it still names stopped threads, as the daemon counts every unarchived one.
- No thread-view banner (the mockup's bottom half was not wanted).

## Gotchas

- `ComposerPicker` gained `warning`: absent for pickers that never warn; `null` while the
  Work in picker is clear. The Tip wraps the trigger whenever `warning !== undefined`, so
  the trigger does not remount when the warning comes and goes. The Tip's `data-state`
  wins on the button, so the open look now keys on `aria-expanded:` (for every picker).
- The chip's tooltip sits on its icon, not the chip body: hovering the name still opens no
  tooltip (composer-fixes 11, 13).
- The banner is frosted (`backdrop-blur-xl`) like the card; without it the backdrop image
  showed through the 7% amber tint.
- The mock's seed threads already give a banner: s-1 (busy) on code-foundry's main
  checkout, s-2 (connected, waiting) on ghostty-playground's, s-6 closing in dotfiles,
  s-8/s-9 snoozed, s-7 archived. `e2e/composer-collision.spec.ts` uses them for "2 of 3".

## Verification

- Unit: `lib/collisionHints.test.ts` (wording: x of y, singular, single, mixed branches,
  folders; tooltip line; structured collisions), `lib/thread.test.ts` (running filter,
  working flag), `Composer.test.tsx` (banner, pill warning, new-branch button, non-running
  threads ignored, live start/stop, set chips).
- e2e: `composer-collision.spec.ts` (new), `project-sets.spec.ts` and
  `composer-fixes.spec.ts` updated from `composer-hint(s)` to `composer-collision`.
- Screenshots against the mock daemon, dark and light, set and single project.
