# One generated command index (2026-11-06)

The eval found about 20,000 tokens of per-skill `commands.md` that nothing opened, and 75% of the
guide's 8-word phrases repeated in orchestrate's. Models use `--help` for detail. This PR replaces
both dumps with one list of verbs, slims the guide, and moves the entry skill's two
single-purpose sections out of every load.

**Users need a daemon restart**: skill files are written at daemon start. Install replaces
`.claude` whole, so both old `commands.md` files go on that restart with no migration.

## What changed

- **Index**: `code-foundry/reference/commands.md`, verb and title per category, 7,605 bytes as
  installed, rendered by the daemon. The other skills name its path through `{{cf.commandsRef}}`.
  Both per-skill `commands.md` files are gone.
- **`code-foundry guide`**: 27,623 to 10,137 bytes: intro, shared conventions, the index. Thread
  conventions and detail are `guide thread` (22,572 bytes, under the 29,000 topic limit).
- **`Command.NoIndex`** replaces `leftOut`, and `no_index` is on the wire, because the guide renders
  from `v1.Command`. A new verb needs only its registry entry: `TestIndexFollowsTheRegistry` plants
  one, and a new category too. `index_test.go` pins the 13 marked verbs.
- **`pr.checks` is now listed**: of `leftOut`'s 14 it is the one a model can use (it was out for
  room). The other 13 are GUI controls or the user's own.
- **Kept as code**: the `plugin.*`, `skill.*`, `dictation.*` and `search.*` namespace rules. Those
  namespaces are the user's or dynamic, so a flag would add 30 lines and change no output.
- **`help` in a thread**: no flag only the GUI or CLI sets, common flags on one line.
  `help thread new` is 5,388 to 4,564 bytes and `thread.subscribe --help` 2,205 to 1,896. Hidden
  flags still parse. Plugin references keep `HelpReference`.
- **Budgets**: entry body 8,300 to 6,800, guide 29,000 to 11,000, topics stay 29,000. Orchestrate's
  body fell 30 bytes and help's rose 72 (the path is longer than the old name); both stay in budget
  and neither number moved.

## The thread signal

`$CODE_FOUNDRY_THREAD` alone is not reliable: a thread's action runs have it too, and those may be
a person's terminal. Only a thread's Claude process has the thread id **and**
`$CODE_FOUNDRY_ENDPOINT`. Plugins and search runs have the endpoint alone, plain terminals neither.
`cli.inThread` needs both, and `TestHelpInAThread` covers the matrix through all three help forms.

## Why the entry skill changed too

Not in the original plan, and the gate is why. Guidance by source in the before side: skill bodies
72%, `help` 12.5%, `guide` and `commands.md` nothing, so deleting what nobody read could not move
the mean. Replaying the `help` trim over the recorded runs saved 43 tokens a run, inside the
noise of about 170.

"Making a theme" (900 bytes) and "Scopes" (597) loaded on 30 of 54 runs and served only theme and
scope requests. They are now `reference/making-a-theme.md` and `reference/scopes.md`, word for
word, with the routing rows pointing there. The entry body fell 18%, 7,863 to 6,438.

`t8` exercises the theme move. **No eval task exercises the scopes move**, so routing to
`reference/scopes.md` is unmeasured: 0 reads, because nothing asked.

## Result

Opus 5.5, medium, Claude Code 2.1.316, 3 runs per task, 0 invalid. `make guide-eval-compare`: PASS.

| | Before | After |
|---|---|---|
| Runs | 54 | 54 |
| Skill loaded | 45/45 | 45/45 |
| Correct verb | 54/54 | 54/54 |
| Guidance tokens per run | 6,233 | 5,986 (-247) |
| Always loaded | 1,473 | 1,473 |
| Failed CLI calls | 14 | 12 |
| Help hops | 31 | 36 |
| Monitor or Cron fetches | 2 | 2 |
| `daemon.capabilities` calls | 7 | 4 |
| Index reads | 1 | 7 |
| `guide` calls | 0 | 0 |
| Cost in the runs | $14.97 | $14.39 |

The fall clears the noise floor, by 77 tokens. No per-task drop in skill or verb. The size of the
files touched has no run noise: 535 tokens off each entry load.

**After report, for the next PR's before side:**
`~/.cache/code-foundry/guide-eval/after-opus-index-5b95e4064/`. Its build is the PR's skills and
registry; later commits touch only docs and the scorer.

### Where tokens moved

| Task | Before | After | Why |
|---|---|---|---|
| `t3`, `t4`, `p1` | 4,602 | 4,067 | The entry skill |
| `p7` | 8,679 | 5,244 | Greps the index instead of capabilities, all 3 runs |
| `p4` | 2,516 | 1,473 | Loaded no skill: noise, as the baseline note says |
| `t6` | 8,378 | 10,459 | One run read `patterns.md` whole (15,036): noise |
| `t7` | 13,225 | 14,648 | Plugin skill reads, unrelated to this PR: noise |
| `p6` | 9,402 | 10,780 | Pages reads; before's low run was 5,984: noise |

Help hops rose by 5. By task: `t9` +2, `t6` +1, `t7` +1, `t8` +1, `p7` +1, `p8` +1, `p6` -1, `p5` -1,
others level. `t9`'s are new and unexplained: its row did not change. Those two runs cost 723 and
815 tokens more than the third, which also made one `daemon.capabilities` call between them, and it
can only be read as 3 runs against 3.

### Reading the runs

The start of every final answer (300 characters) on both sides, all 18 tasks, and round 1's
transcripts of `t4`, `t8`, `t9`, `p2`, `p7`, with `t9` round 2. No answer read got worse. `t8` got the
ends of its answers read too. The rest of a long answer was not read, so this is a sample.

- **`t8`**: all 3 read `making-a-theme.md`, saved with `theme save --apply`, never touched the
  themes folder, and checked 7:1 and 4.5:1 by hand. Each said the app's own check did not run.
- **`t4`** (closed PR): all 3 looked at the PR first and told the user it may never fire, as before.
- **`t9`**: nobody took the key in chat, and each said nothing appeared. **One difference**: all 3
  before runs created `.env` first, 2 of 3 after runs did not, and those are the two that read
  `view.panel.file --help`, which says to run `--edit` and end the turn. That is the documented
  flow, and with no window here it leaves no file.
- **`p7`**: `grep` of the index, then `thread.set-model --help`, then the verb. This is the use the
  index was built for.
- **`p2`**: still open on both sides. One after run added a second alert for a close without merge.
- **`t6`**: one after run reports a clean merge where others conflict; its branches touched
  disjoint files.

### Sonnet, as a worker only

Report only. `p8` and `p4`, 3 runs, against `baseline-sonnet` (same skills and registry): verbs 6/6,
no invalid run. `p4` 3,559 to 3,202. `p8` 1,768 to 1,915, one more help hop on two runs. One `p8` run
asked whether to leave the commit or publish, instead of finishing: a sensible stop, and the reason
that run shows no final text and $0.

## The before side

**Not a fresh run of all 54.** A full Opus side is about $15, so two would be about $31 against the
$22 approved. Between the baseline build `b1e0a6de9` and `ff599b1b9` the diff is terminal frontend
code, the harness and tests: skills, `ThreadPrompt`, the registry, guide code and embedded docs
are identical. So the before side is `baseline-opus` copied (11 tasks at 3 runs, 7 heavy tasks at 1),
plus rounds 2 and 3 of the heavy tasks on `ff599b1b9`. Same Claude Code, model and effort. The
copy rescored to the baseline's numbers first, and every run's prompt matched `tasks.json`. Its
`meta.json` was restored to all 18 tasks and names both builds. It sits beside the after report as
`before-opus-index-ff599b1b9`.

The after side ran round 1 alone, was read, then rounds 2 and 3 were added to the same report.

## Scorer fix

`commands_md_reads` said 0 on both sides while 7 after runs used the index. A shell read keeps only
the first 90 characters of its command, and the scratch path fills them. It now counts from the
whole command. The same cut hid one before-side read (`p7.r1`), so the audit's flat 0 was 1 here.

## Cost

| | |
|---|---|
| Before side, 2 rounds of 7 heavy tasks | $6.61 |
| After side, 3 rounds, Opus | $14.66 |
| Sonnet worker check | $0.52 |
| Total, by the daemon's count | $21.79 |

## Gotchas

- `make guide-eval-compare` needs a fall of 1 token. The 170-token floor is a reading, not a check.
- A skill row is what routes; an index only helps once a model is looking. Nothing here grew the
  entry's rows beyond the one pointer.
- `thread.new`'s `(default: settings ...)` line lost its daemon test with the file that held it. It
  is the registry's description, which `help` prints live, so it cannot go stale.
- `eval.py --tasks` rewrites `meta.json`'s task list: a partial fill needs it restored, or the
  report covers only those tasks.
