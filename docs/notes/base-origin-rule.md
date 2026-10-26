# Branch from origin unless the local branch is ahead

Decided 2026-10-26 (product owner). Single-dev projects push to main locally, so the
local default branch is often ahead of origin, and always-origin bases (from
`docs/notes/base-from-origin.md`) made worktrees that missed the newest local commits.
Code: `internal/store/project/startpoint.go`. ListRefs additions are for the next,
frontend PR (the composer's base picker).

## The rule

Per repository, at creation: a bare branch name, or the default branch when no base is
given, starts from origin's copy, fetched first, unless the local branch is ahead of
origin's copy, in which case from the local branch. "Ahead" is
`git rev-list --count origin/<b>..<b>` > 0, so a diverged branch (ahead and behind)
counts as ahead and takes local. When origin has no such branch, or there is no origin,
the local branch is used. A remote-tracking ref typed explicitly (`origin/x`,
`upstream/x`), a tag, a sha or an expression is used as typed.

## Setting and flag

* `projects.base_from_origin` (key, type and default unchanged) is now the kill switch.
  On (default): the rule. Off: always the local branch, nothing fetched (unchanged).
  Title "Branch from origin unless local is ahead"; the description says off means
  local only, never fetch. The mock schema (`gui/frontend/mock/settings.ts`) has the
  same text.
* `thread new` / `project worktree new --base-from-origin yes` means the rule (same as
  the setting on), not "always origin"; `no` means local. The help of `--base`
  (`thread new`, `project worktree new`, `ember task start`) and `--base-from-origin`
  says so.

## ListRefs

* `branches` (3): branch short names, local and origin's remote-tracking branches
  merged by name (`origin/` stripped, `origin/HEAD` skipped, other remotes left out),
  newest commit first, keeping a name's newer date of its two copies; ties by name.
* `default_branch` (4): the default branch's short name, "" when unknown.
* `refs` unchanged. `default_ref` now names the branch, not which copy: `<default>`
  when it is a local branch, `origin/<default>` only when origin's copy is the only one.
  The composer sends `default_ref` as the base when the user picks none; before, with the
  setting on, that was `origin/main`, which is "used as typed" and would have bypassed
  the rule for every GUI thread. `main` gets the rule (on) or the local branch (off), so
  sending it is the same as sending no base. The API handler no longer reads the setting
  for ListRefs (`Refs.Default(fromOrigin)` removed); it maps the store's fields.
* One `for-each-ref` call as before; its format gained the commit date
  (`%(refname)%09%(symref)%09%(committerdate:unix)`, tab separated) and parseRefs
  sorts by date itself rather than asking git to (`--sort` would not dedupe anyway).

## Gotchas

* The comparison runs after the fetch, so "behind" means behind origin as it is now,
  not the last fetched copy. With Fetch false (`project worktree new --fetch=false`) it
  compares with the existing `origin/<b>`.
* A failed `rev-list` (should not happen: both refs were just checked) warns and uses
  origin's copy, the old behaviour.
* Resolution to the local branch logs at Info:
  `base resolved to the local branch, ahead of origin's base=main start_point=main
  ahead=1` (also without a typed base, since that is the surprising case).
* The workspace store's "branch only on origin" handling and the `--track` exception
  for a base of `origin/<branch>` are unchanged.
* `refs/heads/<b>` and `refs/remotes/origin/<b>` are passed to rev-list in full, so a
  tag with the branch's name cannot shadow either side.
* The guide's after-split cap (25,500 bytes, `internal/guide/topics_test.go`) holds
  `thread new`'s flag help: the first wording went over, the shipped one ("unless the
  local one is ahead") leaves the guide at 25,498. The settings description carries the
  diverged case; the flag help says only "ahead".
* The compose e2e expected "From origin/main"; the mock now returns `main` like the
  daemon, so it expects "From main" and `base: "main"`.

## Tests

* `TestStartPoint` (table, scratch origin one commit ahead of the clone): local ahead
  (no base and `--base main`) → local; behind → origin; equal → origin; diverged →
  local; origin lacks the branch → local; no remote → local, no fetch; off with local
  ahead → local, no fetch; a lead's branch ahead of its older pushed copy → local;
  `origin/main` → as typed. Each asserts the worktree's head, `Worktree.StartPoint`,
  the fetch count and the Info line.
* `TestParseRefs` (ordering, dedupe, newest copy wins, other remotes and symrefs left
  out), `TestListRefs` (default ref is the local branch; `origin/main` when there is no
  local one; "branches by recency" on a fake repo with dated commits on local only,
  origin only, both with either newer, and another remote).
* API: `TestProjectListRefsAndCreateFetch` maps the new fields;
  `TestProjectBaseFromOrigin` checks the default ref no longer depends on the setting.
* e2e: `compose.spec.ts` and `settings.spec.ts` pass against the mock.
* Not run end to end against a daemon: this build's scratch repos had to live under
  `/tmp`, and `project add` only takes folders under home. The store tests above use
  real git repositories (bare origin, a second clone pushing) through
  `Store.CreateWorktree`, the same call every daemon caller makes; the callers' wiring
  of the setting and flag is unchanged.
