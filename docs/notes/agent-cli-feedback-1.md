# Agent CLI feedback 1: filters compose with --all, the guide marks --yes (2026-10-18)

An agent driving code-foundry from inside a thread (through `code-foundry guide`,
`cmd/code-foundry/guide.go`) reported where the CLI tripped it. This step fixes the one
correctness trap and closes the guide gaps. A second, parallel PR adds `thread reports`
and multi-id `thread remove` / `thread archive`; it is not part of this one.

## The feedback, briefly

1. `thread list --all --label x` listed every thread: `--all` silently dropped every
   other filter (`--label`, `--status`, `--project`, `--created-by`, ...).
2. Destructive commands exit 2 inside a thread (no terminal to confirm on) and the guide
   never said that `--yes` is needed; the agent asked for `--yes` to be implied there.
3. No documented way to list "my children"; the agent asked for `--created-by` to
   default to the calling thread.
4. Collecting the children's reports took one `thread get` each; it asked for one call,
   and for the report `--data` to be validated against a schema.
5. Unclear what `--project` takes, and what `thread new` works in without
   `--new-worktree` (it expected the GUI's "New threads work in" setting to apply).
6. Cleaning up many children took one `thread remove` / `thread archive` per id (the
   second PR).

## Decisions

* **`--all` composes.** `ListOptions.All` (and `ThreadFilter.all`) now means
  `IncludeArchived`; every other filter still applies, `limit` included. The API still
  adds the retired usage ledger to the answer with `all`, so `--all` and `--archived`
  differ only in `--json`. Project and workspace refs are resolved with `--all` too, so
  `--all --project nope` is now InvalidArgument (it used to list everything).
  * Not a `--scope live|archived|all` enum: a breaking flag change that gives three
    spellings for what `--archived` already says, for no gain once `--all` composes.
  * Not a warning: the list would still be wrong, and an agent parsing stdout (or
    `--json`) does not see stderr reliably. Making the obvious invocation right is the fix.
  * No caller changes behaviour: the GUI's `listThreads` sends no filter at all, and
    `threadNames`, `threadIDs` (id suffixes) and `app restart`'s restart cost pass `all`
    alone (with `limit`).
* **`--yes` is not implied inside a thread.** Confirmation guards the irreversible
  commands (remove, delete, merge, kill, restart), and an agent acting on a mistyped id
  suffix is exactly what it is for. The guide now shows ` --yes` in the usage of every
  command with `requires_confirmation` (from the registry, so it cannot drift) and an
  intro bullet says that without it they exit 2 and do nothing. Some confirm only in some
  states (archive and snooze only a thread that is mid-turn), hence "may ask".
* **`--created-by` does not default to the calling thread** on `thread list`. A filter
  default that applies only inside a thread would make the same command list less there
  than in a terminal, silently: the same class of trap as item 1. `thread new
  --created-by` defaults to it because it records, not filters. The guide gives the
  explicit form: `thread list --created-by $CODE_FOUNDRY_THREAD`, and `--created-by user`.
* **No schema validation of report data.** `--data` is free-form per task: creator and
  child agree on its shape in the brief, the daemon only checks it is a JSON object of at
  most 16 KiB. A schema would need a registry and versions for something the reading
  agent can check itself in one line. For now the guide says `thread list --created-by
  $CODE_FOUNDRY_THREAD --json` carries every child's `reportStatus`, `reportSummary` and
  `reportData` in one call; the second PR's `thread reports` rewords that line.
* **`--new-worktree` help** says that without it the thread works in the given worktree,
  else the project's own checkout, and that the GUI's `threads.default_worktree` ("New
  threads work in") does not apply. The CLI has no active worktree unless
  `--context-worktree` is given, so it is the project's main checkout in practice.
* **Guide conventions**: `--project` takes a project id or name (`project list` prints
  them); the `thread list` bullet gives `--all`'s new meaning; a "Your children" line.

## Gotchas

* **The guide's byte budget is nearly spent.** `TestGuide` caps it at 29,000 bytes
  (Claude's Bash tool sets anything over about 30,000 aside in a file). The test's
  registry is not the daemon's: the live daemon adds the settings defaults to `--model`
  and `--effort` (about 50 bytes), so the live guide is larger than the test sees. After
  this step: 28,972 in the test, 28,995 live. To fit, `thread.list`'s description lost
  "; at most limit threads" (the `--limit` line says it). The next guide addition must
  trim something first.
* **The guide's `thread archive <id>` convention is wrong today**: `thread.archive` takes
  `--id`, and `thread archive s-...` exits 2 with "unexpected arguments". Left as is; the
  second PR's multi-id archive makes ids positional.
* `make check` and `make build` started together in a fresh worktree race on the
  libghostty-vt fetch into `third_party/ghostty-src` and both fail; delete that directory
  and run one first.

## End to end

`make build`; daemon in `CODE_FOUNDRY_HOME=/tmp/cf-lfc-home`; two `--no-project` threads
on Haiku 4.5 with no prompt (Claude did no work), one labelled `x` and archived. "Before"
is origin/main built from `git archive` against the same libghostty-vt, on the same home.

```
$ code-foundry thread list --all --label x          # origin/main
s-1fb465a1f758  idle  Plain one     no project  53s
s-ecc7fbaf2234  idle  Labelled one  no project  54s  [archived]
$ code-foundry thread list --all --project nope     # origin/main: exit 0
s-1fb465a1f758  idle  Plain one     no project  53s
s-ecc7fbaf2234  idle  Labelled one  no project  54s  [archived]

$ code-foundry thread list --all --label x          # this branch
s-ecc7fbaf2234  idle  Labelled one  no project  17s  [archived]
$ code-foundry thread list --label x
no threads (archived threads are left out; --archived includes them)
$ code-foundry thread list --all --created-by user
s-1fb465a1f758  idle  Plain one     no project  16s
s-ecc7fbaf2234  idle  Labelled one  no project  17s  [archived]
$ code-foundry thread list --all --project nope     # exit 2
code-foundry thread.list: invalid argument: no project "nope"
$ code-foundry thread remove --id s-1fb465a1f758 </dev/null   # exit 2, nothing removed
code-foundry thread.remove: Remove thread s-1fb465a1f758? Claude stops if it runs, and the thread is forgotten.
Re-run with --yes to confirm.
```

`code-foundry guide` (28,995 bytes), the changed lines:

```
- Commands shown with `--yes` may ask for confirmation; without it they then exit 2 and do nothing, so pass
  `--yes` when you mean it.
  `--project` takes a project id or name; `code-foundry project list` prints them.
- `thread list` leaves archived threads out (`--archived` or `--all` includes them; the other filters still apply)
  and shows the 50 most recently active (`--limit 0` for all); filter with `--status`, `--label`, `--project`.
- Your children: `code-foundry thread list --created-by $CODE_FOUNDRY_THREAD`; `--created-by user` lists the
  threads no thread created.
- Your children's reports in one call: `thread list --created-by $CODE_FOUNDRY_THREAD --json` has each one's
  `reportStatus`, `reportSummary`, `reportData`.
- `thread.archive [--id] --yes` Archive a thread: ...
  - `--all`: Every thread, archived ones too (--json: also the usage of removed threads); the other filters still apply
  - `--new-worktree`: Create a new worktree for the thread (branch cf/<slug of the thread name>, named from the prompt); without it the thread works in the given worktree, else the project's own checkout (the GUI's threads.default_worktree does not apply)
- `thread.remove [--id] --yes` Forget a thread, stopping Claude first if it runs.
- `pr.merge <repo-slug> <number> --yes` Merge an open pull request ...
```
