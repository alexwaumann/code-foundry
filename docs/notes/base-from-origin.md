# Branch from origin (projects.base_from_origin)

Decided 2026-10-20 (Alex), third PR of the branch naming + auto pull series. A setting
decides what a new worktree's base means. Code: `internal/store/project/startpoint.go`.

## What changed

* **Setting** `projects.base_from_origin` (Bool, default on, Source control › Projects,
  right after Branch instructions), titled "Branch from origin". Live: every caller
  reads it per worktree, as `projects.branch_naming` reaches the thread store.
* **On** (the default):
  * no base: `origin/<default>` after fetching it (as before);
  * a bare branch name (`main`, `release/2.3`): origin's copy is fetched with an
    explicit refspec (the existing fetch-before-worktree path) and, if
    `origin/<name>` then exists, the branch starts there; if origin has no such branch,
    the local ref is used as typed. The resolution is logged at Info
    (`base resolved to origin's branch base=main start_point=origin/main`);
  * a remote-tracking ref (`origin/x`, `upstream/x` for any configured remote): as
    typed, fetched first (as before); a tag, a sha or an expression (`HEAD`, `HEAD~2`,
    `@{u}`, `refs/…`): as typed, never fetched.
* **Off**: no base is the local default branch; a base is used exactly as typed; the
  base is never fetched, not even `origin/x`.
* **One place.** `project.CreateWorktreeOptions.BaseFromOrigin` drives
  `Git.startPoint`, called from CreateWorktree's new-branch path. The daemon-side
  callers pass the setting: the thread store (new worktrees and recreated worktrees,
  `Options.BaseFromOrigin`), the workspace store (members, `Options.BaseFromOrigin`)
  and ProjectService (`CreateWorktree`, `WithBaseFromOrigin`). All three default to on
  when not wired (tests, fakes).
* **Recorded base.** CreateWorktree returns the resolved ref as `Worktree.StartPoint`
  (return value only, never in a snapshot). The thread records it as its `BaseRef`
  (`nw.baseRef`), so a thread made with `--base main` shows `origin/main` and
  `thread new` prints "new worktree from origin/main". Workspace members carry it the
  same way (`Member.StartPoint`, only on what Create and AddProject return), so a
  workspace thread records its member's start point.
* **ListRefs' default ref** follows the setting (`Refs.Default`, new
  `Refs.DefaultBranch`). The composer sends the default ref as the base when the user
  picks none, so with the setting off it now sends `main`, not `origin/main`, which
  would otherwise have been "used as typed" without a fetch (stale). The composer's
  "From the default branch" (shown only when refs failed to load) stays accurate.
* Help text: `thread new --base`, `workspace new --base`, `workspace add-project
  --base`, `ember task start --base`, `project worktree new --base` said "default:
  origin/<default branch>"; they now say "the default branch; a branch name means
  origin's copy, fetched, unless projects.base_from_origin is off". The `--fetch`
  flags say nothing is fetched with the setting off. Proto comments updated
  (regenerated).

## Decisions beyond the brief

* **Classifying a bare name** (`classifyBase`): a configured remote's prefix wins;
  then anything that cannot be a branch's short name is an expression; then a local
  branch wins over a tag of the same name (it was picked from the branch list); then a
  tag; then a hex string that resolves to a commit is a sha; anything left is taken for
  a branch only origin has (`release/2.3` not checked out locally), so it is fetched.
* **No base is treated as the bare default branch.** Before, the default fetched only
  when `origin/<default>` already existed locally; now it is fetched whenever origin
  is configured, and a missing one falls back to the local branch. Same result for
  every normal clone.
* **Off with no local default branch** (only `origin/<default>` exists) uses
  `origin/<default>` without fetching rather than failing.
* **A bare name origin lacks** is fetched once per worktree and fails with "couldn't
  find remote ref"; that is logged at Debug, not as a fetch warning. Any other fetch
  failure (unreachable origin) still warns and uses the existing ref, which may be a
  stale `origin/<name>`.
* **Fetch false with the setting on** (`project worktree new --fetch=false`) still
  prefers an existing `origin/<name>` without fetching.
* **Left as is:** git's DWIM checkout of a branch that exists only on origin
  (no base) still fetches that branch with `Fetch`; it is the existing-branch path,
  not a base. The `--track` exception (a base of `origin/<branch>` itself) applies to
  the resolved base, so `--branch foo --base foo` with `foo` only on origin tracks it.

## Gotchas

* `CreateWorktreeOptions.BaseFromOrigin`'s zero value is off. The project store's own
  tests that relied on the old default now set it; the thread, workspace and API
  layers default to on when their option is nil.
* The workspace store strips `Member.StartPoint` before storing: a snapshot reloaded
  from the database could never have it, so the live snapshot doesn't either.
* With auto pull on, a live project's main checkout may be fast-forwarded between
  fetches, so "off branches from the stale local tip" is only stale until the next
  auto pull. The end-to-end run turned auto pull off to show the difference.

## End to end

Branch binary, `daemon --dev` with `CODE_FOUNDRY_HOME=/tmp/cf-bfo/home`, naming model
Haiku 5.5, auto pull off. Bare origin under `~/cf-scratch-bfo`, a clone registered as
the project, a second clone pushing commits so origin's main is ahead of the clone's
`main` and `origin/main`. Threads on Haiku 5.5 at medium effort.

* On: `thread new --new-worktree --base main` printed "new worktree from origin/main";
  the worktree was at origin's tip (6c24ac6) while local main was 946c599; no
  upstream; Info line `base resolved to origin's branch base=main
  start_point=origin/main`.
* `settings set projects.base_from_origin false` (no restart), another commit pushed:
  `thread new --new-worktree --base main` printed "new worktree from main", at the
  stale local 946c599; no fetch logged.
* Off, origin URL pointed at a missing repository, `project worktree new` with no
  base: made from local main, no fetch tried, no warning.
* Back on (no restart), `project worktree new --base main`: fetched, at origin's new
  tip c026685, no upstream.

## Tests

* `internal/store/project/startpoint_test.go`: `TestClassifyBase` (table),
  `TestRefsDefault`, `TestStartPoint` (scratch origin one commit ahead; on/off × no
  base, bare name on origin, bare name only on origin, bare name not on origin,
  `origin/main`, another remote's branch, tag, sha: head, `StartPoint`, fetch count via
  the counting runner, no upstream, no warning, the Info line only when it resolved),
  `TestStartPointOffNeverFetches` (unreachable origin, off: no fetch tried).
* `refs_test.go`'s `TestCreateWorktreeFetch` cases set `BaseFromOrigin` where they
  test the on behaviour.
* Wiring: `TestNewWorktreeBaseFromOrigin` (thread: the setting per call, the start
  point recorded), `TestCreateBaseFromOrigin` and `TestCreate` (workspace: passed,
  returned start points, none stored), `TestProjectBaseFromOrigin` (API: CreateWorktree
  and ListRefs' default per call, on without the option), `TestBaseFromOrigin`
  (daemon: settings read live), the recreate test's expected options.
