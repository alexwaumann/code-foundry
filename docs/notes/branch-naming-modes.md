# Branch naming modes

Decided 2026-10-20 (Alex). Replaces the fixed `cf/<slug of the thread title>` branch of
new worktrees and new workspaces with a configurable scheme, and lets
`thread new --branch` steer it. Code: `internal/store/thread/branchname.go` (modes,
composition, collisions), `naming.go` (one call, prompt, reply parsing).

## What changed

* **One naming call returns the title and the branch.** `Namer` now takes a
  `NamingRequest` (first message, the explicit name as context, and a `BranchRequest`
  when a branch is wanted) and returns `Naming{Title, Branch}`. The prompt asks for two
  labelled lines (`Title: ...` / `Branch: ...`); `parseNaming` also reads a JSON object,
  tolerates markdown around the labels, takes the first of each label, and reads an
  unlabelled reply as a bare title. A reply with only a branch gets a title from the
  branch's last component (`feat/add-filter` -> "Add filter"). Threads without a new
  worktree still ask for the title only (the old prompt), from the transcript path.
  One call per thread, the 429 retry, the hardened flags and the minimal fallback are
  unchanged.
* **Settings** (Source control page, projects group, all live, read per Create through
  `Options.BranchNaming` which the daemon builds from the settings store):
  * `projects.branch_naming`: `semantic` (default), `prefix`, `custom`.
  * `projects.branch_prefix`: default `cf`. An empty value resets a setting to its
    default, so "no prefix" is the word `none`; the value is checked (letters, digits,
    `-`, `_`, `.`, `/`).
  * `projects.branch_instructions`: custom mode's instructions, verbatim to the model.
* **Modes.** semantic: `<type>/<slug>`, the type validated against feat, fix, chore,
  docs, ci, refactor, test, perf, build (anything else, or none, is `chore`). prefix:
  `<prefix>/<slug>`, a bare slug without a prefix. custom: the model's whole branch,
  whitespace runs made dashes, then `git check-ref-format --branch` (no repository
  needed); a refused one falls back. Slugs go through `slugify` (6 words, 60 bytes);
  a `--branch` slug through `workspace.Slug` (60 bytes, no word cap: the user chose it).
* **Fallback** is `cf/<thread id>` in every mode: namer failed, nothing usable, or the
  10 s wait (`Options.SlugTimeout`, up from 6 s) ran out. The thread still waits on the
  namer before the worktree is made; no provisional branch, no rename.
* **Explicit `--name`**: the namer still runs, for the branch, with the name as
  context; the reply's title is dropped (and a late reply is not applied).
* **`threads.auto_name` off**: `settingsNamer` returns `thread.ErrNamingOff` without a
  model call; the branch is then `<prefix>/<slug of the name>` in prefix mode, else
  `cf/<id>` (both say so in the setting's description).
* **`thread new --branch`** (proto `NewWorktree.branch`, `NewWorkspace.branch`; needs
  `--new-worktree`, also with `--projects`): with a `/` it is the branch, verbatim, and
  the namer only titles. Without one it is the slug: `<prefix>/<it>` (no model call
  when the thread also has a name), `<type>/<it>` with the model choosing only the type,
  or a hint next to the custom instructions. A `--branch` branch that exists locally or
  on origin is checked out, never suffixed, and `--base` is dropped with an Info line.
  Only generated branches get `-2`..`-9`. The composer has no branch field.
* **Workspaces**: the same scheme, one branch for every member; a workspace without an
  explicit name is named after the branch's last component (`feat/add-filter` ->
  `add-filter`), and the suffix search still checks that name against existing
  workspaces. `workspace new` without `--branch` asks `Options.DefaultBranch` (the
  daemon wires the thread store's `WorkspaceBranch`): the name's slug in the current
  mode, the namer asked for the type (semantic) or the branch (custom); nil or a refused
  custom branch keeps `cf/<slug of the name>`. The workspace store now drops a member's
  base when the branch exists only on origin, so it is checked out tracking origin
  instead of being made again from the base.

## Decisions beyond the brief

* A `--branch` slug survives a failed or late namer: semantic gives `chore/<slug>`,
  custom `cf/<slug>`, prefix needs no model. Losing a slug the user typed for
  `cf/<id>` seemed worse than the uniform fallback.
* When the reply has no branch field, semantic and prefix modes slug the title rather
  than fall back to the id (the old behaviour, so a model that ignores the format still
  gives readable branches).
* `Options.BranchNaming` is a function on the thread store options rather than a
  context value: the thread store needs the mode itself (composition, auto-name off,
  `--branch`), not just the namer.

## Gotchas

* `git check-ref-format --branch` works outside a repository, so `validBranch` needs no
  project path.
* Fakes: `threadtest.Fake` keeps `cf/<N>` (the fallback) and honours
  `NewWorktree.Branch` (slash verbatim, else `chore/<it>`); `workspacetest.Fake`
  defaults to `cf/<slug of the name>` like the real store without `DefaultBranch`.
* The orchestrate skill is at its line cap; the `--branch` mention replaced the old
  `cf/<slug>-2` sentence rather than adding lines.
