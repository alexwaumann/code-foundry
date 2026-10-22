# thread new --base-from-origin

## Decision (2026-10-22)

When a thread is created with `code-foundry thread new`, the model decides where it
goes: in place (the project checkout) or `--new-worktree`. Prompts and skills do not
push it either way, and the user steers when it matters. The Settings values
`threads.default_worktree` and `projects.base_from_origin` are defaults for the user's own
composer threads, not for the model. So the model needs a way to be explicit wherever a
setting would otherwise decide. `thread new` already left placement to its flags (the
setting is read by the GUI only). The base was the missing piece: with
`projects.base_from_origin` on, `--base feat/x` meant origin's copy. A worker could
therefore not branch from a lead's local commits that origin does not have yet, unless the
user turned the setting off for everyone.

## What changed

- `thread new` and `project worktree new` take `--base-from-origin yes|no`. It is an Enum
  arg whose empty default means "the setting", and it overrides
  `projects.base_from_origin` for that call only. It goes through the proto as
  `optional bool base_from_origin` on `NewWorktree` (3), `NewWorkspace` (5) and
  `CreateWorktreeRequest` (6). After that it becomes a `*bool` on
  `thread.NewWorktree`/`NewWorkspace` and `workspace.CreateOptions`, and finally
  `project.CreateWorktreeOptions.BaseFromOrigin`. Resolution is unchanged and still lives
  in `startpoint.go`. The new code only decides which bool that function gets: the
  override when one is set, otherwise the setting's function (`Manager.fromOrigin` in the
  thread and workspace stores, `CreateWorktree` in `internal/api/project.go`).
- `thread new --projects` (a new workspace) passes the flag on to every member. `workspace
  new` and `workspace add` did not get the flag (no one asked for it). They still follow
  the setting.
- Without `--new-worktree` (or `--projects`), and with `--no-project`, the flag is
  refused, just as `--base` is.
- The verb is `project worktree new`. The brief called it "create".

## Semantics

The new branch's start point, by typed base and flag (fetches are bounded; a failed one
falls back to the existing ref):

| `--base` | `yes` | `no` | unset |
|---|---|---|---|
| none | `origin/<default>` when origin has it, fetched; else the local default | the local default branch, no fetch | the setting (default on: as `yes`) |
| bare branch (`main`, `feat/lead`) | `origin/<branch>` when origin has it, fetched; else the local branch | the local branch as typed (local commits included), no fetch | the setting |
| remote ref (`origin/x`, `upstream/x`) | as typed, that branch fetched first | as typed, not fetched (possibly stale) | the setting |
| tag, sha, expression (`HEAD~2`) | as typed, no fetch | as typed, no fetch | as typed |

A worker branching from a lead's unpushed branch uses `--base feat/lead
--base-from-origin no`. Once the branch is pushed, `--base origin/feat/lead` works under
any setting. The new branch is a snapshot: commits the lead adds later reach it only
through a rebase.

## Prompt and skills

- `ThreadPrompt` used to say "threads work In place unless the user picks Fresh copy (a
  worktree); ". It now says "thread new: the project checkout or --new-worktree (--base,
  --base-from-origin yes|no), your call; ". That is the mechanics with no recommendation,
  and it is still one line with no backticks, `$` or newline (control-7). The paragraph
  grew from 1,398 to 1,428 bytes, and the byte cap went from 1,400 to 1,430. Measured with
  `claude -p --output-format json --model haiku` (Haiku 5.5, the same one-word prompt,
  only the append changed): 4,036 to 4,048 input tokens, so +12 tokens per request.
  `TestSystemPrompt` also checks that the clause contains none of "In place", "Fresh
  copy", "prefer" or "unless the user".
- Entry skill: "Work in" is now described as the composer's control for the user's own
  threads, defaulting to `threads.default_worktree`. "Threads you create with `thread new`
  are yours to place: in place or `--new-worktree`." The bullet grew by one line, so the
  skill-loading sentence was shortened to one line (cap 70 held).
- Orchestrate skill: the sibling-branch line now covers both cases, `--base
  origin/<branch>` once pushed and `--base <branch> --base-from-origin no` before that
  (cap 138 held). `reference/patterns.md` §2b explains the unpushed case and the
  snapshot caveat, and `reference/leads.md` mentions it where leads stack pieces. The
  existing rule that workers get a new worktree stays: a worker editing the lead's
  checkout is a correctness hazard, not a preference. No "prefer worktrees" or "prefer in
  place" text was added.
- Capabilities: no group text describes thread placement. The commands group renders verb
  help from the registry, so the new flag shows up there with nothing else to change. The
  setting descriptions in Settings are user-facing and were left alone. No CLI reference
  is committed (skill references are rendered at runtime), so the only generated output
  is `make gen` for the proto.

## Verified with

- Table tests: `TestStartPoint` (an on/off pair for a lead branch that origin has an older
  copy of, plus the unpushed case), `TestNewWorktreeBaseFromOrigin` (setting × override),
  `TestCreateNewWorkspace` (the override reaches the workspace store),
  `TestCreateBaseFromOrigin` (workspace store), `TestProjectBaseFromOrigin` (API override),
  and the command tables for `thread.new` and `project.worktree.new` (yes, no, refused
  values, refused without a new worktree or with `--no-project`).
- End to end against an isolated daemon (`CODE_FOUNDRY_HOME=/tmp/…`), using a scratch repo
  under `$HOME` with a bare origin, `feat/lead` (pushed, then one more local commit),
  `feat/local` (never pushed) and origin's `main` one commit ahead and not yet fetched.
  Each `thread new --new-worktree --base … --branch e2e/…` was followed by `thread
  archive`:
  - `--base feat/local --base-from-origin no` started from the local commit, with no
    fetch.
  - `--base feat/lead --base-from-origin no` started from the unpushed local tip. This
    held with the setting on as well.
  - `--base main --base-from-origin no` started from local main, and the project's
    `origin/main` stayed stale.
  - Unset with the setting off started from local main.
  - `--base feat/lead --base-from-origin yes` with the setting off started from origin's
    copy (log: "base resolved to origin's branch").
  - `--base main --base-from-origin yes` started from origin's tip.
  - Unset with the setting on fetched (the project's `origin/main` moved) and started
    from origin's tip.
  - `project worktree new --base feat/lead --base-from-origin no` gave the local tip, and
    `yes` gave origin's copy.
  - `thread new --base-from-origin no` without `--new-worktree` was refused: "only applies
    with new-worktree".
