# Thread info card 1/5: daemon facts

Status: done on branch `cf/thread-info-facts` (one PR, daemon plus the `src/api` mappers
and the mock; no GUI surface). It is the first of five PRs that build a per-thread info
card beside the conversation (T3-Code style). This one publishes the facts the card reads:
the git operation's step counters, the context window, the action to run again, the
installed editor apps, a placement check before a send, and trust for Run in. One commit
per item.

## 1. Git operation progress

Already there. `project/operation.go` reads `rebase-merge/msgnum`+`end` and
`rebase-apply/next`+`last` where it detects the operation (`readOperation`, during the
status refresh, no git command), into `Status.OperationStep`/`OperationTotal`, published as
`GitStatus.operation_step`/`operation_total`. A thread's checkout carries the same
`GitStatus` (`ThreadCheckout.status`, PR #401), and the GUI maps both
(`api/project.ts`, `api/checkouts.ts`). The brief's `op_step`/`op_total` names would have
duplicated these fields, so nothing new was added: one API test
(`TestCheckoutsToProtoOperation`) pins that a thread checkout carries them (0 for merge,
cherry-pick, revert, bisect; no status for a path the project does not list).

## 2. Context window

* `model.Model` gains `ContextWindow` (tokens), `model.ContextWindow(value)` reads it
  (0 for a value the registry does not list: an alias, a full name the API accepted,
  claude's default). Values are Anthropic's published windows (models overview, as of
  October 2026): 1M for every listed model, including Haiku 5.5, and **200K for
  Haiku 4.5**, which has no 1M variant (its `[1m]` id is listed for a Bedrock
  setup; the suffix does not make it 1M).
* `Thread.context_window` (71) is filled from the thread's current model (`Thread.model`,
  not the model that answered the last turn, `ContextModel`: the card shows the window the
  next turn will have). The GUI maps it (`ThreadView.contextWindow`) and never hardcodes a
  window; the mock fills it from its copy of the registry (`mock/settings.ts` `MODELS`).

## 3. Action runs per thread

* Migration `0050_action_runs.sql`: one row per run, written when it starts (`id` = the run
  id, `action_id` → `actions` ON DELETE CASCADE, `project_id`, `thread_id` ('' for a
  worktree's run), `runner` terminal|background, `trigger` user|worktree_create,
  `started_at` ms). Real users upgrade in place: it is a new table
  (`TestActionRunsMigration` runs it over a pre-0050 database with an action).
* The store writes the record in `start` after the run started (both runners, both
  triggers), and trims the project to its newest `RecordHistory` (500) in the same
  transaction. A failed write is logged; the run goes on. Runs themselves stay in memory
  (the newest 50 per project), as before.
* `action.PickAction(actions, records, threadID)` is pure (table test): the action last
  run in the thread, else the project's most recently run action (any thread or a
  worktree's run), else the project's first action, else nothing. **Only user-started runs
  count**: an on-worktree-create run is a setup step (npm install), not what the card
  should offer to run again. A record whose action was deleted is skipped (the cascade
  removes them anyway). `LatestByAction` is each action's newest record, any trigger.
* Proto: `ActionService.LastRun(project_id, thread_id)` → `source` (THREAD, PROJECT,
  FIRST; UNSPECIFIED with no actions), `action`, `last` (the record that chose it).
  `ListActionsResponse.last_runs` is each listed action's newest record. `ActionRunRecord`
  is the record.
* CLI: `action list` gains a LAST RUN column ("3 min ago, here", "2 h ago, thread s-…",
  "just now, worktree", "never") and a last line naming the pick for the active thread
  (`CODE_FOUNDRY_THREAD`), else the project's. `action.last` (NoPalette, read-only; the
  palette/read-only/keybinding pins updated) prints the pick alone, `--thread` for
  another thread. The existing action verbs are unchanged.
* GUI: `toActionRunRecordView`, `toActionPickView`, `getActionPick` in `api/actions.ts`;
  the mock records every run and serves `LastRun` and `last_runs`.

## 4. Open in <app>

* `gitops/apps.go`: `knownEditors` is the registry (VS Code, VS Code Insiders, Cursor, Zed,
  Windsurf, Sublime Text, IntelliJ IDEA and CE, GoLand, PyCharm and CE, WebStorm,
  PhpStorm, RubyMine, CLion, RustRover, Rider, DataGrip, Xcode), each with its bundle
  names and a fallback bundle id. Detection looks in `/Applications`,
  `~/Applications` and `~/Applications/JetBrains Toolbox` (older Toolbox installs), the
  system's copy first, and reads the real `CFBundleIdentifier` with `plutil -extract`
  (the registry's id only when that fails). One bundle id is listed once.
* Cached on first use (`Manager.EditorApps`). `RefreshEditorApps` marks it stale; the
  daemon glue `daemon/editor_apps.go` calls it on every `settings.Changed`; the request's
  `refresh` detects at once. An `--app` naming an id the cache lacks detects again once
  before refusing (an editor installed since), then `ErrInvalidArgument` listing what is
  installed.
* `GitOpsService.ListEditorApps(refresh)` → `EditorApp{name, bundle_id, path}`;
  `OpenEditorRequest.app` (4) opens the worktree or file with `open -b <id> <path>`
  (no line: `open` takes none). `worktree.open.editor --app <bundle id>`;
  `worktree.editors` (NoPalette, read-only) lists them. Terminal is not part of this
  (cmd+J stays the shell path).
* GUI: `toEditorAppView`, `listEditorApps` in `api/gitops.ts`. The mock had no
  `GitOpsService` (the GUI runs git ops through commands); it now serves
  `ListEditorApps` only, and its `worktree.open.editor` takes `app`.

## 5. Placement check

* `thread.Manager.CheckPlacement(PlacementCheck{ProjectIDs, Branch, CheckoutMode})` →
  per project, in id order: `new` (a worktree would be made at the default path; path ""
  while the branch is named at the Create), `share` (the existing checkout and its
  branch), `folder` (a plain folder), `refused` (the Create's refusal for that project; the Create joins several), plus the
  branch the Create would use (or `branch_named_at_create`).
* **The same code paths**: project refs go through `placeRequest` (unknown project, one
  listed twice, a bad base); the branch through `newBranchChoice` +
  `existingBranchChoice`, and is known without the namer only when it is verbatim (a
  slash, or an existing branch's name) or a prefix-mode slug (`composeBranch` with no
  reply, as `waitNaming` does when no model is needed). Each git member is decided by
  **`worktreeFor`**, extracted from `makeWorktrees`' up-front loop, which now calls it:
  the branch's worktree (`memberWorktree`), else `mainCheckoutBusy`, else
  `defaultPathTaken`. The check passes `onDisk` true (a stat, as `makeWorktree` does under
  its lock), so it also sees a git checkout at the default path the project does not list.
  A set of plain folders gets `placeWorktrees`' refusal (`noGitForWorktree`, extracted),
  naming the first project given as the Create does.
* Not considered: like and creator inheritance, a workspace, `--worktree <path>`. The
  check is for the composer's explicit set; a child's placement depends on its creator.
* `ThreadService.CheckPlacement`; `thread.placement.check --projects a,b --branch X --mode
  worktree|checkout` (NoPalette, read-only). GUI: `api/placement.ts`
  (`toPlacementView`, `checkPlacement`); the mock implements a simplified version (no
  naming settings: any non-empty branch is used as is).
* `TestCheckPlacement` runs each case's Create after the check and asserts it did exactly
  that: the same refusal text, the same shared path, the new worktree at the reported
  path. Cases: a new branch, a worktree on the branch shared, the main checkout on the
  branch, the #401 default-path worktree switched away, checkout mode, no branch, a
  prefix-mode slug, a slug the namer wraps, a plain folder beside a git project, plain
  folders alone.

## 6. Trust for Run in

* Root cause (reproduced on a scratch daemon before the fix): `streamCd` already wrote the
  target's trust right before `set_cwd`, but the running claude did not see it yet:
  `run in failed … needs_trust`, and the same Run in 20 seconds later moved the thread.
  Worktrees the app makes are trusted when made, before claude starts, so only project
  folders (an in-place member) hit it.
* Fix: `spawn` calls `preTrustCheckouts`, which trusts the cwd **and every other member's
  checkout** (`memberDirs`, the add-dirs) before claude starts, with the rule a thread
  created in that folder gets: trusted unless `DisablePreTrust`. `streamCd` keeps its
  write for a member recorded since the spawn.
* `TestSpawnPreTrustsEveryCheckout` (an in-place two-project thread: both folders trusted;
  none with pre-trust off). It fails with only the cwd trusted.

## The agent guide

The three new queries (`thread.placement.check`, `action.last`, `worktree.editors`) took
the generated guide from under its 25,500-byte soft cap to 26,102 (`TestWriteTopic`).
They are GUI facts, not agent work, so they join the guide's `leftOut` list beside
`thread.new-like` and `composer.history`; `code-foundry commands` and `help <command>`
still show them.

## Gotchas

* Copying a new build over an executable a stopped daemon ran (`cp bin/code-foundry
  /tmp/x`) gets the next start SIGKILLed (exit 137, no log line): macOS caches the code
  signature per inode. Copy to a new path (or `rm` first).
* `make gen` also rebuilds the page library bundle; check `git status` for unrelated
  generated changes (there were none here).
* The scratch account's naming model (Sonnet 4.6 `[1m]`) failed with "Usage credits
  required for 1M context": threads kept their provisional names. Unrelated.
* The trust entries written for the scratch folders stay in `~/.claude.json` (harmless,
  for folders since deleted); the daemon never removes trust.

## Verified

* `make check` green.
* Scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cf-tif-home`, repos `web`, `api`, `lib` under
  `~/cf-tif-scratch`, Sonnet 5.5 medium, one-word prompts), CLI only:
  * 6, before the fix: an in-place thread on `web,api`, idle; `thread run-in --project
    api` → `needs_trust` in the log; again 20 s later → moved. After the fix (new build):
    a thread on `web,lib` (lib never trusted): the start logged `pre-trusted … lib`, and
    `run-in --project lib` moved it on the first try; back to web likewise.
  * 3: two background actions on web; `action list` → LAST RUN never, pick the first;
    `CODE_FOUNDRY_THREAD=<t> action run Test --wait` → list in the thread: "just now,
    here", pick Test (this thread); `action last --thread <other>` → Test (project); a
    worktree run of Build → the other thread's pick is Build, the thread's still Test; a
    terminal run recorded `runner=terminal`; after a daemon restart `action runs` is empty
    and `action list` still shows both LAST RUN cells and the thread's pick.
  * 5: `--branch main` → both refused with `mainCheckoutBusy`'s text, and `thread new
    --new-worktree --branch main` refused the same way; `feat/x` → two new worktrees at the
    default paths; no branch → named at create; checkout mode → each main checkout on
    main. A thread on `feat/p` in api: the check shares its worktree; after `git switch -c
    other` in it the check refuses with "api's worktree for feat/p at … has other checked
    out now; thread s-… works in it; …" and `thread new --projects api,lib --branch
    feat/p` failed with the same text.
  * 4: `worktree editors` listed VS Code with the bundle id read from its Info.plist;
    `worktree open editor --app com.example.nope` refused, naming what is installed. No
    real app was opened.
  * Daemon log: no warnings or errors besides the pre-fix `needs_trust` and the naming
    credits above. Scratch repos, home, binary and transcripts removed.
