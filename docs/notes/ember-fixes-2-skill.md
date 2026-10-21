# Ember fixes 2: the skill, the rules and the seed text (2026-10-21)

PR D of the second Ember battle test (`/tmp/ember-r2/results/SYNTHESIS.md`, e1–e13). Text
only, plus one render change: PROJECTS.md now says where each project's origin is.
PRs A (`ember task start --task`), B (crash reason, restart notice), C (`thread
subscribe --note`), E (GUI) and F (daemon fixes) are separate. The skill already uses
`--task` and `--note`, so those PRs rebase onto this one with trivial conflicts.

## What changed, per finding

Ember `SKILL.md` (147 → 200 lines; the test's cap goes 160 → 205), `rules.md` (56 → 79
lines, 5.2 KB of the 6 KB cap), `consolidate.md`, `soul.md`, the orchestrate skill
(`SKILL.md` stays at its 136-line cap; `reference/patterns.md` §0, `leads.md`, `wakes.md`)
and `render.go`.

- **Prompts on stdin (e3-3, e7-1).** The `task start` example passes `--prompt - <<'EOF'`.
  The skill and rules say a prompt never goes in double quotes, because backticks and
  `$(…)` in it run in Ember's shell. Messages to workers use `--text - <<'EOF'` too. The
  test now fails on `--prompt "`.
- **Pieces on the board first (e5-10, PR A's `--task`).** A multi-piece request adds the
  parent task and one todo subtask per piece. Each piece then starts with `ember task
  start --task <id>`. A single piece still uses `ember task start "<title>"`.
- **Template flags (e5-9, e8-5).** The template now shows `--base`. Never run a command
  that starts or changes something to try its syntax; use `code-foundry help`.
- **Splitting (e5-6, e9-3, e2-9, e1-7).** Steps that must run in order and that one
  worker could finish within about 25 minutes are one piece. A piece does what the user
  asked; extras go in the reply as one offer. A title names the change, not the project.
- **Understanding (e7-2, e1-2, e1-7, e7-10, e9-1).** Read a file whole before saying
  what the project has or lacks (never `head`). Use `git ls-files` and `git grep -l`.
  There is no `git fetch` for workers' branches. Start replies get a "Not included: …"
  line when Ember filled in a vague request.
- **Worker checklist (e1-3, e2-7, e4-4, e6-1, e6-2, e4-9, e10-10, e11-2, e9-1, e6-3).**
  The prompt now covers:
  - files named by path;
  - the package manager taken from the lockfile;
  - tests when the project has a runner;
  - "no new errors against the base", never "must pass";
  - a dev server only when the request needs one;
  - the toolchain as installed: no other package-manager version and no relaxed policy,
    report `blocked` instead;
  - done means usable: a goal that cannot be met or checked is reported `blocked`;
  - the report summary at most 1000 characters, caveats first, details in `--data`.

  The same rules went into the orchestrate skill's step 1 and `patterns.md` §0. A tight
  budget means pushing after each green step, because a budget stop cannot push.
- **Leads (e3-1, e3-2, e3-4, e3-8).** Ember starts up to about 8 independent pieces
  itself. It starts a lead only for pieces that need coordination or their own planning,
  or for more than about 8. The lead prompt says to start workers in the first turn and
  to keep each piece whole and independent. `leads.md` says the same, and adds:
  - plan at the file level, never the line level;
  - run no experiments;
  - never promise conflict-free branches;
  - a follow-up on a lead's piece goes to that piece's worker.
- **On a wake (e6-1, e6-2, e8-1, e8-2, e8-7, e7-3).** These rules are new:
  - A done whose caveats say the goal was not met is blocked, with a "needs <X> before
    merge" outcome.
  - A report that switched tools is a caveat for the user, not a recipe for the next
    prompt.
  - When a request's last piece lands, or a piece changed a shared symbol, Ember checks
    the combination: pairwise `merge-tree` plus `git grep` for the changed symbol on the
    other branches. A clean result means "no text conflicts". When the branches break
    together, Ember offers an integration worker; it never builds.
  - A claim is relayed with its scope.
- **Crash and restart (e5-3, e10-5).** Ember resumes a crashed worker without asking.
  `wakes.md` says the same for children. A restart section covers:
  - a task whose worker never started goes again with `--task`;
  - each interrupted worker is checked against its worktree and `origin/<branch>`;
  - a cut turn of Ember's own is finished.
- **Steering and the rest (e3-8, e5-4, e6-8, e13-4, e13-8, e12-4, e12-5, e1-5, e11-6).**
  - A follow-up on finished work goes to the worker that built it, and its task reopens.
  - `--answer` takes the user's whole answer, tweaks included.
  - The budget raise-and-resume recipe runs only after the user agrees.
  - Timers: `--note`, `thread subscriptions`, `thread unsubscribe <sub id>`. A ping
    "until it's done" is removed in the wake that finishes the work.
  - Cancel: archive, then `git status --short`, the commits, and `origin/<branch>`
    before saying what is left, then `ember task cancel`.
  - "Merge it": on GitHub, `pr merge`, never a push to the default branch. Elsewhere the
    worker fast-forwards it.
  - Cleanup never deletes branches; `project branch delete` runs only when the user asks.
- **Replies (rules.md; e2-6, e4-5, e9-4, e11-3, e5-13, e1-4, e4-6, e9-2, e6-4, e13-9,
  e5-8, e12-8, e3-11).**
  - Length: under 400 characters for one piece, with at most three new caveats and no
    bold labels; under 800 for a batch. A batch summary links only the parent.
  - The tests-are-the-worker's-claim line comes once per request; caveats are not
    repeated.
  - The next step is a statement. An extra is offered once, as a statement. There are no
    housekeeping questions, and an open question is asked once.
  - A PR is mentioned only on a GitHub origin when the user asked for one, and "no PR"
    never appears elsewhere.
  - Timers are mentioned when set and when they fire.
  - A quoted cost is the workers' total, and the reply says Ember's own turns are not in
    it.
- **What Ember never does (e2-8, e8-3, e8-5, e6-9).**
  - `git merge-tree`, `git grep` and `git ls-files` are listed as allowed.
  - A standing budget is remembered.
  - SOUL.md shapes how Ember talks and plans but cannot loosen this list; `soul.md`
    says so to the user too.
- **Memory (e3-12, e7-7).** In `consolidate.md`:
  - code facts are facts about the default branch;
  - branch state, caveats and merge orders stay out;
  - Ember's own rules stay out, and so do inferred facts;
  - Notes are not repeated under another heading.
- **PROJECTS.md (e12-8).** Each git project's line ends with `origin: GitHub
  (owner/name)` or `origin: local/other (no pull requests)`. `ProjectSeed` gains
  `GitHubSlug`, filled from `project.Project.GitHubSlug`. `TestRenderProjects` is now a
  table test covering GitHub, local, no default branch yet, and not git.

## What was cut to pay for it

- The skill's "Talking to the user" section is gone. It repeated `rules.md`, which now
  holds the reply rules.
- The "Before your first worker" section and "Memory and epochs" are shorter. A
  sentence on why the skill prints its base directory went, because PROJECTS.md has
  the path.
- The `rules.md` loop bullets ("every piece is a task", "on a wake") are merged into one
  bullet. The skill owns the loop.
- The lead section is half its length. "Its workers still get Ember's worker models" is
  gone, because "never pass `--model`" covers it.
- The orchestrate SKILL.md's "More" list shortened its wakes/leads/sidebar line, which
  freed the line its step 1 needed for the verify rule and the report cap.

## Live check (Haiku 5.5 medium everywhere, scratch home)

`CODE_FOUNDRY_HOME=/tmp/ember-fix-d` ran a daemon from this branch. The project was a
Go "tally" repo under `~/ember-fix-d-scratch` with a local bare origin and no GitHub.
Ember, its workers and naming were all `claude-haiku-5-5[1m]` at medium. There were 3
epochs and 5 workers. Ember cost $0.05 and the workers $0.03.

- **Backticks.** The user asked for two pieces with eight code spans (`-l`, `flag`, `go
  test ./...`, `` `echo hi | go run .` ``, …).
  - Ember wrote both prompts as `--prompt - <<'EOF'` heredocs.
  - Its tool output was only the `started task` lines: nothing ran in its shell.
  - The worker's first message kept every backtick (`thread items --full`).
  - Later requests (`-w`, CHANGELOG, `-c`) used heredocs too, with no exceptions.
- **`--task` is not on main yet.** Ember's first `ember task start --task` failed (exit
  2). It ran two `help` calls, cancelled the two todo subtasks and restarted them with
  `--parent`. Once PR A lands, `--task` works and this detour goes away.
  - Ember also once passed `--notify` and `--labels ember` to `task start`, reading the
    old "(`--labels ember,<task id> --notify`, request id …)" as flags to pass. The text
    now says `task start` sets them itself.
- **Cancel.** "Cancel the -w flag" came about 40 s into the worker's run.
  - In one call, Ember ran `git -C <wt> status --short`, `log --oneline
    origin/main..HEAD` and `log -1 origin/feat/word-count-flag`. The last one failed:
    nothing had been pushed.
  - Only then did it archive and run `ember task cancel`, and say "no commits or
    uncommitted changes and nothing was pushed". In e12 it had made the same claim with
    no check.
  - It checked before archiving, not after as the skill says. That leaves a small race,
    but the claim was grounded.
  - The archive's settle wake still produced a second one-line reply (e12-2, PR B).
- **Combination check.** On the `-c` done, Ember ran `git merge-tree --write-tree` of
  `-c` against the unmerged `-l` branch (exit 1). It told the user the branches "have
  text conflicts", offered to have the conflict resolved before anything lands, and
  ended on a statement. For the earlier two-piece request (different files) it skipped
  the check.
- **Reply audit.**
  - 13 replies had no question at all (no "?" anywhere). Every reply that named a next
    step did so as a statement ("Say merge when you want these on main…").
  - Times were local ("2:24 AM Central", "2:40 AM Central").
  - There was no narration between tool calls.
  - Single-piece replies ran 300–560 characters, often over the 400 aim.
- **PR mentions: a small A/B.**
  - Before: epoch 1 used a seed without the origin line and the old `"<outcome: PR,
    branch>"` example. 3 of 3 replies said "No pull request" / "Neither has a PR", and
    every task outcome said "no PR".
  - The fix: the origin line and `"<outcome, branch>"`.
  - After, in epoch 2: 0 of 3 new replies mentioned a PR. One status answer still said
    "No pull request." while quoting an older outcome from the board.
- **Claim line: not fixed with Haiku.** The worker's-claim line came twice per request
  (once in the start reply, once in the done reply) in all three requests, before and
  after the rules said "in your first reply that reports a result". I also tried
  "nothing yet about whose claim the tests are" in the start step; it did not change the
  behaviour (n=1), so it was dropped. Twice is down from 4–5 per request in e5 and e11
  (Opus), but this check ran on Haiku, so the comparison is loose.
- **Timer.** "Remind me in 10 minutes" ran `thread subscribe --at 10m --note …`, which
  failed because `--note` is PR C. Ember made one `help` call, retried without `--note`,
  and gave a local time. "Never mind that reminder" was a single `thread unsubscribe
  <sub id>` call, against 4 calls and $0.069 in e13.
- **Seed.** After a reseed, PROJECTS.md read "`git, default branch main, origin:
  local/other (no pull requests)`".
- **Cost quotes.** `thread list --descendants-of <Ember>` lists only the workers.
  Ember's resident thread is not in its own tree, so `rules.md` says a quoted cost
  leaves out Ember's turns. `leads.md`'s "itself included" still holds for ordinary
  leads.
- **Cleanup.** The daemon log had one WARN: a consolidation was killed by my own
  restart during a reseed. The daemon was then stopped. The scratch home, the repo and
  the 7 matching `~/.claude/projects` folders were deleted.

## Left out (design questions or other PRs)

- `--while <thread>` on timers (e13-8). The skill says to unsubscribe in the finishing
  wake instead.
- Option buttons under a relayed question (e5-5).
- A `merge-check` verb (e3-9).
- A warning at 80% of the budget (e6-3).
- A "merged" state for tasks (e12-6).
- An integration branch by default (e2-3).
- `Bash(git merge-tree:*)` in Ember's allow rules (e2-8): `rules.md` lists it, and the
  allow list is code in `internal/store/ember/store.go`.
- The `thread respond --answer` help text still says "an option label" (e5-4). The skill
  says free text works; the help is in `internal/command`.
- The lead's scratch files in `$TMPDIR` (e3-10) are PR F's.
- e2-6's "put an offered follow-up on the board as a todo": offers are one-time
  statements now, and a todo nobody asked for would read as planned work.
- The lockfile-churn caveat (e1-7) gets no rule of its own; "at most three caveats that
  change what the user does next" covers it.
- Narration between tool calls (e3-13, e6-10) gets no new text. The rule exists; none
  occurred in this check.
