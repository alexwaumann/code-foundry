# Ember fixes 1: skill steering, task start, small fixes (2026-10-20)

This PR fixes S1–S6, D3, D4 and D6 from the first Ember battle test
(`ember-experiments-2026-10-20.md`), and raises the epoch limit's floor. D1, D2 and D5
(lead wakes, sibling counts, consolidation spend) and G1–G6 (GUI) are in other PRs.

## What changed

- **S1, the orchestrate skill.**
  - The Ember skill and `rules.md` tell Ember to load `code-foundry-orchestrate` with the
    Skill tool once per epoch, before its first worker and before any lead. The tool
    prints the skill's base directory, so `reference/leads.md` resolves.
  - PROJECTS.md ends with a "## Skills" section that gives the absolute path of the
    orchestrate skill and of its `leads.md`, for a plain Read. The path is
    `Options.OrchestrateSkill`; the daemon passes
    `<home>/claude/.claude/skills/code-foundry-orchestrate`. `RenderSkills` is pure and
    table-tested.
  - `rules.md` forbids `find /`, `find ~`, `mdfind`, `locate` and any other
    filesystem-wide search.
- **S2 + S3: "Steering and answering" in the Ember SKILL.md.** It covers:
  - steering: `thread send --id <worker>`, plus a rename of the thread and the task
    title (the parent's too) when the goal changed;
  - a worker's question or permission: relayed in Ember's chat with its options, and
    the user's answer sent back with `thread respond --id <worker> --request <id>
    --answer "<label>"` (or `allow` / `deny --message`);
  - timers: `thread subscribe --at <duration|RFC 3339>` (and `--every`);
  - Ember's chat is the user's only place to answer, so it never points the user at a
    worker's thread.
- **S4, "How you talk" in rules.md.** New rules:
  - aim for under 400 characters unless summarizing a batch;
  - write nothing between tool calls; the reply is the turn's last text;
  - mention a branch's base only when the piece depends on unmerged work;
  - say once per request that tests are the worker's claim;
  - give local times, never UTC;
  - relay questions here and never send the user to a worker's thread.
- **S5, memory.** `files/consolidate.md` now says no branch lists, no shas and no
  per-branch status, because the board has them. The skill says `ember remember` is for
  preferences, conventions, people and decisions, never progress, with no date in the
  fact.
- **S6, the time zone.** BOARD.md's "As of" line carries the zone abbreviation
  ("2026-10-20 07:56 CDT"), followed by "Time zone: America/Chicago (CDT), local times.
  …". `ZoneName` resolves `time.Local` from `$TZ`, or else from the `/etc/localtime`
  link, because `time.Local.String()` is "Local". `ember board` prints the same lines.
- **D3, `ember task start "<title>" --project <id> --prompt <text|@file|->`.**
  - Other flags: `--detail`, `--parent`, `--brief`, `--labels`, `--budget`, `--base`,
    `--new-worktree` (default on; `=false` for a lead) and `--created-by`.
  - The command adds the task as doing and calls `thread.new` through the registry
    (`r.Invoke`), so its checks, settings defaults and `ModelDefaulted` marking are
    unchanged. It passes `--name <title> --new-worktree --labels ember,<task
    id>[,extra] --notify --request-id <task id> --created-by <caller or Ember>`.
  - It then links the thread and prints `started task <id> with thread <id> in
    <worktree>`.
  - If `thread.new` fails, the task is cancelled with "the worker did not start: …" so
    no doing task is left without a worker. Budget and base/new-worktree are checked
    before the task is added.
  - `--created-by` defaults to `$CODE_FOUNDRY_THREAD` (Ember's own thread when Ember
    runs it). From the user's CLI it falls back to Ember's resident thread, so the
    worker-model hook and the wake still apply.
  - The skill's loop is now one `ember task start` per piece. The "two separate
    commands, never `$(…)`" warning is gone.
- **D3, `ember task done <id> [outcome] --branch <name>`.** The task is refused unless
  `refs/remotes/origin/<name>` exists in its worker's worktree (`git rev-parse
  --verify`). The worktree comes from `ThreadService.Get`, and `origin/` in front of the
  name is optional. `EmberDeps` gains `Thread` and an injectable `RemoteBranch`.
- **D4.** `Store.Remember` drops a leading `YYYY-MM-DD:` or `YYYY-MM-DD ·` (optionally
  after `- `) before adding its own date.
- **D6.** `Bash(git fetch:*)` is in Ember's allow rules. The skill says to check
  `git -C <worktree> log origin/<branch>` in the worker's worktree, not in the
  project's checkout.
- **Settings.** `ember.epoch_context_tokens` now has a minimum of 50000. Its description
  says a fresh session already starts near 25K. The default stays 400000. A stored
  value below 50000 is ignored with the usual "settings: value ignored" warning, and the
  default applies.

## Live check (Haiku 5.5, scratch home)

- **Setup.** `CODE_FOUNDRY_HOME=/tmp/ember-fixa-home` and a `daemon --dev` from this
  worktree.
  - Ember, its workers, the default and the naming model were all `claude-haiku-5-5[1m]`
    at medium.
  - The project was a scratch tally repo with a local bare origin.
  - `settings set ember.epoch_context_tokens 30000` was refused: "want 50000 to
    1000000".
- **Seed.**
  - BOARD.md started "As of 2026-10-20 07:56 CDT", followed by the Time zone line
    naming America/Chicago.
  - PROJECTS.md ended with the Skills section and the real path of the orchestrate
    skill in the scratch home.
- **A two-piece request** (a `-l` flag, and a CONTRIBUTING.md whose worker had to ask
  "Go 1.22 or any recent Go" first):
  - Ember's first turn ran `Skill code-foundry-ember`, then `Skill
    code-foundry-orchestrate` (both show in `thread read`), then a parent `ember task
    add`. It started the two pieces with two `ember task start --parent …` lines in one
    Bash call. The turn took 18.7 s.
  - It made no `--help`, `help` or `commands` calls and no filesystem search.
  - The question's wake came in. Ember relayed both options in its own chat ("The
    CONTRIBUTING worker is waiting on your answer … Which Go version wording should it
    use?") and did not mention the worker's thread.
  - I answered "Go 1.22." in Ember's chat. Ember ran `thread respond --id <worker>
    --request <id> --answer "Go 1.22"` straight away. The worker wrote the file with
    Go 1.22.
  - On each done wake, Ember checked the branch in the worker's worktree. It used `cd
    <worktree> && git log origin/<branch> && git diff origin/main...origin/<branch>
    --stat`, not `git -C`. Then it ran `ember task done <id> "…" --branch <branch>`,
    which passed.
- **Snag: `--branch` on the parent task.** Ember also passed `--branch` when closing
  the parent, which has no worker. The command refused ("task … has no worker thread
  whose worktree to check"), and Ember closed the parent with `task update --state
  done`. The skill now says a parent task takes no `--branch`.
- **Worker settings.** A third request ran with `ember.worker_effort high` while
  `threads.default_effort` stayed medium. The worker started by `task start` ran at
  high, so the worker-defaults hook still applies through the internal `thread.new`.
  Its labels were `ember, <task id>`, created by Ember.
- **Timer.** The same request said "remind me in 1 minute". Ember ran `thread subscribe
  --at 1m` with no discovery. The wake "Timer … fired at 07:59 CDT" came, and Ember
  replied in one line.
- **Replies.** 6 replies, 59–660 characters:
  - Lengths 444, 245, 660, 504, 370 and 59; the average is 380, against 676 in the
    battle test (which ran Opus).
  - None was mid-turn narration; every reply was its turn's last text.
  - "Tests passing is the worker's claim" appeared twice for the first request, at the
    start and at the end. The rule says once per request.
  - No reply mentioned a branch's base.
- **Totals and cleanup.** 4 threads, 41 requests, $0.04, and no WARN or ERROR lines in
  the daemon log. The daemon was stopped. The scratch home, the repos and the matching
  `~/.claude/projects` folders were deleted.

## Gotchas

- `git -C <worktree> log` does not match the `Bash(git log:*)` allow rule (the prefix
  is `git -C`). Allowing `Bash(git -C:*)` would allow every git verb, so it is not
  allowed. Ember's checks still pass in auto mode, as `git fetch` did before. Haiku
  chose `cd <worktree> && git log …` anyway.
- Worktrees share refs with the project's checkout, so a worker's push updates
  `origin/<branch>` for both. The worktree rule makes sure Ember looks at the right
  checkout. A `git fetch` is needed only for refs pushed by someone else.
- `ember task start` emits thread.new's focus intent, as Ember's `thread new` did
  before. This is unchanged behaviour.
- The mock daemon (`gui/frontend/mock`) does not list `ember.task.start`. The GUI never
  calls it, and the palette hides `ember.*`.
