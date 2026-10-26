# Composer: existing branches in Work in, Branch from

Designed with the product owner as sketches W2 (Work in) and B3 (Branch from), 2026-10-26.
Builds on `docs/notes/base-origin-rule.md` (ListRefs `branches` and `default_branch`).

## What changed

- **Work in: existing branches.** For a single git project and for a set (several projects,
  or a workspace with a git project), the picker shows the two choices (Fresh copy/copies,
  Project folder/folders, wording unchanged) above a "Find existing branch" search and the
  branch rows: short names in monospace with a GitBranch icon, no detail, no heading. The
  source is every git project's `ListRefs.branches` (each newest commit first) merged by
  name position by position in set order, minus the default branches (`lib/compose
  mergedBranches`). The search filters
  the branch rows only. This replaces the single-project "An existing copy" group
  (worktree paths): a branch that has a worktree is picked by name and the daemon reuses
  the worktree (or makes one).
- **Draft model.** `WorktreeChoice` gained `{ kind: "branch"; name }`. thread.new args:
  `new-worktree=true` + `branch=<name>`, never a base, never `:base` suffixes on
  `projects`. The pill is the branch name alone; Branch from is hidden while a branch is
  picked. `{ kind: "existing", path }` stays for the sidebar's "+" on a worktree row and the
  main checkout; that pill still shows the worktree's branch with the read-only indicator,
  and its branch row is the checked one in the list.
- **Branch from (was Base).** Shown for a fresh copy whenever the draft has a git project
  (no longer hidden when the Runs in primary is a plain folder or the workspace folder).
  One flat list under the heading "Branch from": "Default branch" / "Default branches"
  (GitCommitHorizontal, selected by default, the draft keeps `base: null`), then the
  branches every git project has (`commonBranches`: the intersection in the first git
  project's order, minus every project's `default_branch`). "Filter branches…" filters the
  whole list. The footer states the rule only while `projects.base_from_origin` is on. Pill:
  "From default" / "From defaults", else "From <name>".
- **Sending a base.** Nothing picked sends no base (before: `ListRefs.default_ref`). A pick
  goes to every git project of a set as `projects=<id>:<name>,…` (before: the primary
  only); one project sends `base=<name>`. Names only, never `origin/x`.
- **Lazy lists.** The pickers load `ListRefs` for every git project of the draft when
  either opens (`stores/compose loadBranches`, one call per project in flight at a time,
  the last list showing meanwhile; the composer no longer calls ListRefs on mount). The
  store's refs cache keeps `branches` and `defaultBranch` per project; `RefsView` in
  `api/project.ts` still maps `refs` and `default_ref` for whoever needs them.
- **Base resets** when the set's projects change (it was a branch the old set had in
  common), no longer when the primary changes (it applies to every git project).
- **Collision hints.** A branch pick counts as worktree mode on that branch: each git
  member's listed worktree on it is a checkout the hints compare (`draftCheckouts` got a
  `branch`). A worktree the daemon would make is not known before the create, as for
  fresh copies.
- **Daemon: `thread new --branch` without a slash.** Before, `--branch develop` (or `main`)
  was a slug the naming mode wrapped (`feat/develop`), so the composer's pick of any
  slash-less branch would have made a new branch. Now a slash-less value that names an
  existing branch, locally or on origin (refs on disk, nothing fetched) in one of the
  set's repositories, is that branch verbatim (`existingBranchChoice` in
  `internal/store/thread/branchname.go`); anything else is a slug as before. The flag's
  help says "an existing one is checked out; a new one with a / is used as given, else
  ..." (shorter than before: the guide is at its byte cap).

## ComposerPicker

- `PickerGroup.fixed`: groups above the filter box, never filtered (cmdk `forceMount`). The
  filter box then sits inside the list after the last fixed group (cmdk moves only
  through the list's items, so the box has to be inside it for ↑↓ to walk from the
  choices into the branches), sticky so it stays reachable while the branches scroll.
- `PickerGroup.status`: a muted row after a group's options (loading, errors), so Work in
  keeps its two choices while the branches load.
- `PickerOption.icon` / `mono`, and `onOpen` (each opening; the lazy load).
- The highlighted row is controlled now. After each search cmdk highlights the first row
  in the DOM, which with fixed groups is a fixed one, so Enter after typing would have
  picked "Fresh copy". The picker scores the filtered options itself with cmdk's
  `defaultFilter` and turns cmdk's pick of a fixed row away. Gotcha: cmdk sets its internal
  value before calling `onValueChange` and syncs a controlled value only when the prop
  changes, so putting back the same value needs a different string: a trailing space,
  which cmdk trims.

## Decisions

- "Default branches", "From defaults" and "Each project …" follow the number of git
  projects in the draft rather than the set's size: a set of one repository and one plain
  folder has one default branch.
- The "Default branch(es)" row is monospace like the branches, as in the sketch.
- Work in leaves out every git project's default branch, as Branch from does: Project
  folder(s) is how to work on it, and a worktree on the branch a main checkout has is
  refused by the daemon ("a main checkout on the branch", fuzz finding A7). A main
  checkout on some other branch still lists that branch; picking it gets the same refusal.
- Branch from intersects by name only; a branch only on origin in one project and local
  in another counts as common (ListRefs merges the two copies).

## Not changed

- `threads.default_worktree` and its default; the like draft ("New thread on this
  branch"); a project without git (Project folder only, no search).

## Guide

docs/GETTING-STARTED.md's Work in passage: the stale "the pill reads **In place**"
(PR #365 made it Project folder / Project folders) is fixed, and a bullet says the list
also offers existing branches. The help skill's `reference/getting-started.md` is the
same file embedded (`docs/embed.go`, provenance line added at build), so there is no
second copy to edit; `internal/skills` tests check they match.

## Verified with

- Go: `TestCreateNewWorktree` cases "--branch without a slash naming an existing local
  branch is that branch" and "… a branch only on origin".
- Unit: `lib/compose.test.ts` (threadPlace / threadArgs for branch picks and bases on
  every git project, workInText, mergedBranches, commonBranches, Branch from words),
  `stores/compose.test.ts`, `lib/collisionHints.test.ts`.
- e2e (mock): `compose.spec.ts` (defaults send no base, keyboard Branch from, Work in rows,
  a branch pick hides Branch from, local-only project's Branch from), `project-sets.spec.ts`
  ("Work in: an existing branch for a set…", "Branch from: Default branches first…",
  "Branch from: no footer while projects.base_from_origin is off", Workspace folder primary
  keeps Branch from). The mock's thread.new takes `branch` and reuses its worktree.
- `make check`, `make gui-e2e`, `make gui-build`; the built app against an isolated home
  with two real repositories for the screenshots in the PR.
