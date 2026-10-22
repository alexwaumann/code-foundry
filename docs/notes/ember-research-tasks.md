# Ember: research is a task too (2026-10-22)

Text only: the Ember skill, `rules.md`, the `ember task start --new-worktree` help text
and their tests. No change in daemon behaviour.

## The problem

Ember's rules forbade edits and told it to delegate "work", but step 1 of its skill
("Understand it") also told it to read files whole and run `git grep`, `git log` and
`git show`, with no limit. A request like "figure out why X is slow" or "what would it
take to add Y" had no worker-shaped answer, so Ember ran the whole investigation itself.
That cost three ways:

- it spent Ember's context, which is what forces new epochs;
- the user waited on a serial read loop with no board card;
- the findings lived only in chat and were lost at the next epoch.

## The rule

- **Scope.** Ember reads only what it needs to split the work and assign file ownership:
  the project and thread lists, the manifest (read whole), `git ls-files`, and one
  `git grep -l` per piece. Anything past a handful of reads is a research task. So is any
  question whose answer needs understanding code: why something happens, what a change
  would take, where something lives in detail, a review, an audit.
- **A research task** is a piece like any other, started with `ember task start …
  --project <id> --new-worktree=false`. It runs in the project's checkout, with no
  worktree and no branch. Its prompt says it touches nothing: no edits, commits, pushes
  or threads, and no build unless the question needs one. It finishes with `thread
  report done "<answer>" --data '{"findings": [...], "files": [...]}'` (or `blocked`).
- **On its wake** Ember relays the findings and closes the task with `ember task done
  <id> "<finding>"`, with no `--branch`. Then it starts any pieces that waited on the
  answer. A research task can be the whole request or the first piece of a larger one.
- **Unchanged.** Ember still never edits files. App and git actions (merge, archive,
  cleanup, timers, permission answers) stay Ember's own CLI calls.
- **Leads stay distinct.** A lead also uses `--new-worktree=false`, but it plans and
  starts workers. A research worker starts no threads.

In `rules.md`, the first bullet now says "Workers do all the work, research included". A
new bullet says Ember reads only to split and assign, never to answer a question about
code. The "read a file whole" rule stays as its own bullet. `soul.md`'s parenthetical
("it never edits files, builds or pushes itself") already fit and is unchanged.

## Why no change in daemon behaviour

`ember task done`'s description already allows an outcome that is "a finding", and
`--branch` is optional (`internal/command/commands_ember_task.go`). `ember task start
--new-worktree=false` already exists for leads, and it keeps the labels, `--notify` and
request id, so a research worker wakes Ember and links to its task like any other.

The one code change is help text. Ember reads `code-foundry help ember.task.start`, and
the `--new-worktree` flag's text said the project's checkout was "for a lead", which
could make Ember refuse the flag for research. It now says that false runs the worker in
the project's checkout with no worktree or branch: a lead, or a research task that
touches nothing. The behaviour is unchanged.

## Fitting the cap

`TestEmberSkill` fails at 205 newlines. The file was at 204 and is at 204 again. The new
Research section and the longer step 1 (about 12 lines) were paid for by cutting words,
not rules, mostly where the skill repeated `rules.md`, which is Ember's system prompt:

- "Before your first worker of an epoch" was folded into the opening paragraph (the
  Skill tool rule is kept);
- "never run a command to try its syntax" was dropped (`rules.md` has it);
- the budget-stop warning became one clause (`rules.md` has the full rule);
- "A piece does what the user asked" was dropped from step 2 (`rules.md` has it). The
  "extras go in the reply as one offer" sentence is kept;
- in the wake section, "relay with scope" became four words and "a wake with nothing
  worth saying" was dropped (`rules.md` has both);
- the steering preamble, the restart paragraph, wake step 1 and the memory paragraph
  were tightened.

`rules.md` is 5.6 KB of its 6 KB cap.

## Tests

- `TestEmberSkill` checks for these phrases:
  - the scope rule ("never answer it yourself", "per piece. Anything past a handful of
    reads", "is a research task");
  - the Research section and its `--new-worktree=false` start in the project's
    checkout;
  - "touches nothing" and the `"findings"` report;
  - `task done … "<finding>"` with no `--branch`, and the parent-or-research exemption
    in the wake.
- It also fails if "**Understand it.**" or "before you say what a project has or lacks"
  comes back.
- `TestPrefixAndSystemPrompt` checks that `rules.md` has "research included" and the
  scope bullet.

`docs/PLAN.md` was not touched: its Ember entry lists only the three build PRs, and no
Ember follow-up note is referenced there.
