# Guide eval

Measures whether real Claude threads find the right skill and verb from the agent guide and
the built-in skills, and how many guidance tokens that takes. Any PR that changes
`ThreadPrompt`, a skill or the guide runs it before and after. The baseline is in
`docs/notes/guide-eval-baseline.md`.

It spends real money, so it is not part of `make check`: 21 tasks, 3 runs, is about $20 on
Opus 5.5. The 19 without the overlap tasks were $6 on Sonnet 5.5. Run the scorer's tests with
`python3 scripts/guide-eval/score_test.py`.

## Run

```
make guide-eval MODEL=opus LABEL=before BIN=/path/to/before/bin/code-foundry
make guide-eval MODEL=opus LABEL=after          # builds this checkout
make guide-eval-compare BEFORE=<dir> AFTER=<dir>
```

- `MODEL` is `opus` or `sonnet` (Opus 5.5 and Sonnet 5.5, the models users are expected to
  run), one per run. `EFFORT` defaults to `medium`, `RUNS` to 3.
- `BIN` is the build under test; the skills and guide are embedded in it.
- `TASKS=t1-setting,p4-show-file` runs a subset. A subset cannot pass the gate against a full
  report.
- `MAX_COST` (USD, default 24, above a full Opus side) stops launching runs once spent.
  The runs in flight finish, and each thread also has a $4 budget the daemon enforces.
- `eval.py --heavy-runs N` runs the heavy tasks fewer times; `--first-round N --out <dir>`
  adds rounds to an existing report.
- Results go to `~/.cache/code-foundry/guide-eval/<label>-<model>-<effort>-<time>/`: raw
  thread items in `runs/`, `report.json`, `report.md`. `score.py report <dir>` rescores
  them without spending anything, and `score.py show <dir>/runs/<task>.r1` prints a run to
  hand-check.

## Merge gate

`make guide-eval-compare` exits 1 unless all of these hold, per model:

- skill-loaded and correct-verb counts did not drop;
- mean guidance tokens per run fell;
- both sides ran the same tasks the same number of times, at least 3 per task, with no
  invalid run, on the same model, effort and Claude Code version.

Totals decide, so a one-run swing on a noisy task does not block a PR, but the comparison
lists every per-task drop: read them. The token mean is noisy too (the note has the size), so
a small fall proves little alone: a real trim also shows in `always loaded` or in the size of
the files it touched, which have no run noise.

The committed baseline ran the heavy tasks once, so it is a reference, not a side of the gate:
run the before build too.

## Metrics

- **Skill loaded**: the expected skill was loaded on the thread that got the prompt, by the
  Skill tool or by reading its `SKILL.md`. Tasks with no `skill` are not counted.
- **Correct verb**: the task's `verb` regex matched a CLI call by that thread, `--help` aside.
  t1 has no verb to run, so its `answer` regex on the reply also counts.
  `avoid` undoes it: `s1` also fails if the thread reached for `memory add`.
- **Guidance tokens**: always loaded (`ThreadPrompt` as spawned, plus each shipped skill's
  name and description) plus what the run loaded: `SKILL.md` bodies, reference reads, and
  `help`, `guide` and `daemon.capabilities` output, over the thread's whole tree. Bytes
  divided by 2.7, the audit's measured rate (2.3 to 3.0 by file), so the numbers are
  estimates that compare well, not exact tokens. A Bash call that mixes guidance with other
  work counts its whole output. Bash sets an output over 30,000 characters aside and returns a
  preview: that counts as the preview plus what the run reads back from the file. Reports
  scored before this rule need `score.py report` again before a comparison.
- **Wrong turns**: failed CLI calls (the CLI's own error line, so a failure of something else
  in the same command does not count, and `exit=$?` tricks do), `--help` hops, and Monitor or
  Cron fetches. `p8`'s `pr.create` failure is expected: the origin is not on GitHub.
- **Reads of `reference/commands.md`**: a Read of the index, or a Bash call naming it (models
  grep it for a verb, which is what it is for).
- **Cost**: each turn's cost at API rates, over the tree. The daemon's count also has the
  seed threads.

## What a round does

Each round gets its own scratch home, daemon, project and local bare origin under one
`~/.cf-guide-eval-*` folder, then:

1. A seed thread records the `--shout` decision, for `p5` to find with `thread search`.
   Claude's memory files for the scratch project are then removed, or `p5` answers from them.
2. All tasks but the `last` ones run, 6 at a time, each in a new worktree, until the
   thread's whole tree has been quiet for 30 seconds.
3. `t2` and `ember` run last: `t2`'s app memory reaches every thread started after it.

4. `t10-overlap` and `ember-overlap` (`home` in `tasks.json`) each run alone in a home of their own,
   with `OVERLAP_FIXTURE` and Sonnet 5.5 low workers. Ember is one thread per home, and neither
   the project nor the workers' model may reach the other tasks. `t10` starts in the project's
   own checkout (`checkout`), so working in it is a mistake a run can make. Each writes `git.txt`
   into its run; the shared home writes `git-r<n>.txt` beside the report: the origin's branches,
   every pair's `git merge-tree`, and the state of the project's checkout.

`s1` runs in a workspace made for it (`workspace` in `tasks.json`), so `thread checkouts` has a folder
to name. `p7` asks for the other model, so the switch is real on either side. Ember is one thread per
home, one more reason for a home per round.

## Safety

- The scratch root must be a direct child of your home folder named `.cf-guide-eval-*`.
  Under `/tmp`, `view.*` refuses paths ("outside your home directory"), which spoiled two audit
  tasks. `~/.code-foundry` is refused.
- Every CLI call has the scratch `CODE_FOUNDRY_HOME` set and any inherited `CODE_FOUNDRY_*`
  removed, because any call auto-starts a daemon, and inside a thread the CLI would otherwise
  reach the enclosing daemon.
- `gh` is a read-only shim for the daemon and its threads. Refused calls land in
  `gh-denied.log` in the results. `cli/cli` and `octocat/Hello-World` are only read.
- At the end, on failure or on a signal too, it stops only what it started: the daemons it
  launched, their process trees, whatever holds a scratch `daemon.lock`, and processes with the
  run's unique path on their command line. Then it removes the scratch root and Claude's
  `~/.claude/projects` folders for it. SIGKILL is the exception: remove the folder by hand.

## Reading a run by hand

The gate counts routing, and for the orchestrate and Ember skills that proves little: a thread
got started. `t10-overlap` and `ember-overlap` are for what it cannot see. Their four pieces want
more spots in the switch than it has, and the usage line, the README's list and the changelog are
one spot each, so a brief that names no owner or anchor conflicts. Read every run of these, `t6`
and `ember` on both sides, and score: pairs that conflict (`git.txt`), work in the shared checkout,
children whose brief lacks the file split, the length of wake turns, cost, and whether it finished.
The method and the first results are in `docs/notes/guide-orchestrate-ember.md`.

## Limits

- No app window is open:
  - `view.panel.*` (`t9`, `p4`) prints "no app window is open: nothing was shown", exits 0
    and shows nothing, so a run may follow up with a Read. The verb still counts.
  - `view.inline` (`t5`, `p6`) puts its card in the thread, but no page is rendered, so a
    broken page goes unnoticed.
  - `theme save` (`t8`) gets no contrast report: the GUI makes it, so the check says nothing
    was checked and a run may compute contrast by hand.
- Your own `~/.claude` applies (user skills, hooks, MCP servers), like for a real user. Reports
  compare only when they come from the same machine and setup.
- A run is a first turn on a fresh thread. It says nothing about a long thread's routing.
- `t4` and `p2` read real pull requests. `octocat/Hello-World#4` is closed with no checks, so
  declining to subscribe is a fair answer that scores as a miss. Should `cli/cli#13505` merge,
  `p2` changes meaning too: pick another open PR, on both sides of a comparison. `#14957`, its
  first PR, merged between two sides on 2026-11-06, and every run rightly set no reminder.
- Claude Code adds each scratch folder to `projects` in `~/.claude.json`, about two entries a
  run. The harness leaves them: other sessions write that file at the same time. They are
  harmless and name folders that no longer exist.
