# Guide eval baseline

`scripts/guide-eval/` runs a fixed task set through real threads and scores which skill and
verb they found, what guidance they loaded and what it cost. The rework of the guide and the
skills that follows uses it to prove each PR drops no routing and costs fewer guidance tokens.
How to run it, what each metric counts and the merge gate are in its README.

## Baseline

Build `b1e0a6de9`, Claude Code 2.1.316, medium effort, 2026-11-05. All 80 runs valid.

| | Opus 5.5 | Sonnet 5.5 |
|---|---|---|
| Runs | 40 | 40 |
| Skill loaded | 31/31 | 25/31 |
| Correct verb | 40/40 | 35/40 |
| Guidance tokens per run | 5,291 | 4,244 |
| of which always loaded | 1,473 | 1,473 |
| Wrong turns | 29 | 23 |
| failed CLI calls | 8 | 6 |
| `--help` hops | 19 | 12 |
| Monitor or Cron fetches | 2 | 5 |
| `code-foundry guide` calls | 0 | 0 |
| `daemon.capabilities` calls | 2 | 1 |
| Reads of `reference/commands.md` | 0 | 0 |
| Cost | $8.81 | $3.52 |

**Not 3 runs per task.** A full round cost $5.29 on Opus and $1.95 on Sonnet, so 3 rounds of
both would have been about $22, over the approved amount. The 11 tasks under $0.30 on Opus ran
3 times. The 7 others (`t5`, `t6`, `t7`, `t8`, `p6`, `p7`, `ember`) ran once, so read those as
single samples. The two models' figures are comparable with each other, not with a full side.

The heaviest guidance, in tokens for a run on Opus: `t8` 12,859, `t7` 12,598, `p7` 11,670,
`p6` 10,105. `p7` shows the discovery cost: it found `thread.set-model` through
`daemon.capabilities` and two help hops, on both models. Help hops are the main wrong turn:
`p3` and `p2` ask for `thread.subscribe --help` almost every run, and `p8` for `pr.create --help`.

## Sonnet's misses

All six skill misses are the model not reaching for a skill at all, and five of them cost the
verb too:

- `t4` 1/3 and `p2` 2/3: `p2`'s miss watched the PR with Monitor and `gh`. `t4`'s run 3 found the
  PR closed with no checks and sensibly declined, so at least that miss is the task's fault.
- `t8` 0/1: it looked for a sidebar in the repo and asked which project was meant.
- `p5` 2/3: the miss found the seed through `thread list`, read it and answered correctly,
  without `thread search`. Strict scoring calls that a miss.
- `t9` 2/3: the miss got the verb from the system prompt, so only the skill counts as missed.

## What is noisy

- Guidance tokens per run: with nothing changed, Opus's rounds 2 and 3 gave 4,135 and 4,430 on
  the same 11 tasks (Sonnet 3,787 and 3,904). From that one pair, two 3-run means could differ by
  roughly 170 tokens by chance, so a smaller fall proves nothing alone. Always-loaded tokens and
  file sizes have no such noise.
- By task on Opus: `p4` 1,473 to 4,602 (whether it loads the entry skill, which it need not),
  `p8` 2,379 to 5,706, `p5` 4,602 to 5,620. Most others did not move.
- Routing on Opus did not vary. Routing on Sonnet did, on `t4`, `p2`, `p5` and `t9`: those are
  where a change could seem to help or hurt by chance.
- Cost is steady: Opus's two 11-task rounds were $1.67 each.

## Against the audit's single run

| | Audit (Opus) | Here (Opus, round 1) | Here (Opus, all runs) |
|---|---|---|---|
| Skill loaded | 14/15 | 15/15 | 31/31 |
| Correct verb | 17/18 | 18/18 | 40/40 |

- The audit's one miss, `t4`, did not recur in 3 runs. It looks like noise, on Opus at least.
- `t5` and `t9` no longer fail with "outside your home directory": the scratch home is under
  home. `t9` is clean in 3 runs, and `t5` has one help hop.
- `p5` found its seed thread on every Opus run. In the audit it found only itself.
- Always loaded is 1,473 here and was 1,368 there. Here it is bytes at 2.7 per token, there it
  was measured, so this estimate runs 8% high. Later PRs compare like with like.
- Guidance tokens are not comparable with the audit's bytes: the audit left out `SKILL.md` bodies
  and counted root threads only.
- `t7` cost $0.37 here. The audit's row has no turn end and $0, so it was likely scored mid-run.
- The audit's `commands.md` and `guide` zeros held on both models, in all 80 runs.

## Scorer check

Hand-checked 12 runs against their raw items: `t1` on both models, `t8` and `p2` on Sonnet,
`p8.r2`, `p5.r2` and `t6.r1` on Opus, and `t4.r3`, `p5.r3`, `t9.r1`, `p3.r2`, `p4.r2` on Sonnet.
Also every CLI failure in Opus `t7`, `t8`, `p5` and Sonnet `t7`. Skill, verb, failures, hops,
fetches and guidance bytes matched what the runs did, once these were fixed:

- Sonnet's `t1` named the setting by its label, not its key, so the answer check missed it.
- CLI calls were read out of heredoc bodies and Markdown backticks (a plugin's README).
- `p8` excused any `pr.create` failure, hiding the real `missing --worktree` turn. It now
  excuses only "not on GitHub".

`score_test.py` holds these cases and the gate's.

## Comparison check

Run on cuts of the real reports, nothing spent:

- Opus round 2 against round 3: FAIL, under 3 runs, and tokens did not fall.
- Opus's 11 tasks against the same runs with the entry skill 15% smaller and `ThreadPrompt` 10%
  smaller: PASS, 4,414 to 4,012 tokens per run, always loaded 1,473 to 1,412.
- Opus against Sonnet: FAIL, model differs, routing 24 to 19, verbs 33 to 29, each drop listed.

## Cost

$12.33 for the baseline ($8.81 Opus, $3.52 Sonnet), about $0.60 for smoke runs, so about $12.90
for this PR. A full side is about $16 on Opus and $6 on Sonnet.

## Gotchas

- A seed that reads like a decision ends up in Claude's memory files, shared by every worktree of
  the project. `p5` then answers from memory and never searches. The seed says not to save it,
  and the runner removes the scratch project's memory folder after it.
- `p7` asks for the model the run is not on. Asking Sonnet to switch to Sonnet would need no verb.
- `p8` could reach for `project.github.publish`. Opus read its help: the local origin makes it
  unavailable, and `gh` is a read-only shim besides, so no repository can be created.
- With no window, `view.panel.*` exits 0 and shows nothing, and `theme save` checks no contrast.
  The README lists the tasks this limits.
- The CLI inside a thread prefers `CODE_FOUNDRY_ENDPOINT` over the socket. Run from a thread, the
  harness would have reached the real daemon had it not removed every inherited `CODE_FOUNDRY_*`.
- `make`'s first target is `plugins`, so `guide-eval` sits below `attest`: placed first it would
  make a bare `make` spend money.
