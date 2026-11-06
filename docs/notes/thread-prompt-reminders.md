# Reminders in ThreadPrompt

## Not shipped

This clause was tested and rejected: `ThreadPrompt` does not have it, and the rest of this note
is the record of why. For Opus 5.5, the model that orchestrates, the baseline had no reminder
misses. The clause's only gain there was removing two Monitor or Cron detours. It cost an extra
help hop per run and about 640 guidance tokens on `t4`, and it needed a clause cut to fit.
Sonnet's gain does not count: Sonnet runs as a worker, never as the orchestrator.

## The clause

`ThreadPrompt` has nothing on "later" or "when", so a reminder can reach for Monitor or cron
instead of `thread subscribe`. The final candidate was:

    later/when: check, then thread subscribe, not Monitor, cron;

1,640 bytes against the unchanged 1,641 cap, in place after the cost clause.

## What would have paid for it

"page verbs (view.*) move every window: prefer panel verbs; " (59 bytes), not the page clause
("a page, mockup, chart…"). control-7 added it after a thread ran `view.projects` off screen.
That case is now refused by the daemon (`errNotViewed`, control-5). The help skill keeps the rule
and the "show:" clause still names the panel verbs. One loss: workspaces-v2-5-skills took the
rule out of the entry skill because `ThreadPrompt` had it, so a thread that loads only the entry
skill would no longer have read it.

"never suggest /model" and "never hand-made worktrees" were not candidates: file-edit-3-agent
records an earlier cut of them being reverted.

## Wording tried

Sonnet 5.5, medium, 3 runs per task, reminder tasks.

| | Wording | Bytes | t4 | p2 | p3 | p1 | Fetches |
|---|---|---|---|---|---|---|---|
| main | none | 1,638 | 0/3 | 2/3 | 3/3 | 3/3 | 4 |
| v1 | later or when: thread subscribe, not Monitor or cron | 1,633 | 3/3 | 3/3 | 3/3 | 3/3 | 0 |
| v2 | remind, watch, when: thread subscribe, not Monitor or cron | 1,639 | 3/3 | 3/3 | 3/3 | 3/3 | 0 |
| v3 (final candidate) | later/when: check, then thread subscribe, not Monitor, cron | 1,640 | 2/3 | 3/3 | 3/3 | not run | 0 |

Verb counts. The main row is the before side, whose fetches include one on `t4`.

## Why not v1: t4 by hand

v1 scored best and was worse. `t4` reads a closed PR with no checks. A `checks_passed`
subscription needs the PR open, so on a closed PR it never fires, stays in place, and says
nothing. v1 sent the models straight to the verb.

| t4, 3 runs each | Looked at the PR | Told the user it cannot fire | Subscribed |
|---|---|---|---|
| main, Sonnet | 3 | 3 (closed) | 0 |
| v1, Sonnet (after side) | 0 | 0 | 3 |
| v3, Sonnet | 3 | 3 (one closed, two "no checks") | 2 |
| main, Opus | 3 | 3 (closed) | 3 |
| v1, Opus (after side) | 2 | 2 (closed) | 3 |
| v3, Opus | 3 | 3 (closed) | 3 |

So main's Sonnet 0/3 on `t4` was three sensible declines, not routing misses, and v3's one miss
is a fourth. `t4`'s verb score says nothing here in either direction.

## p2

`cli/cli#14957` was open throughout. Sonnet: main 2/3, its miss watching with Monitor and `gh`;
v3 3/3 on the verb, skill 2/3 (one run went from `thread subscribe --help` to the verb). This one
run is the only true routing gain, and p2's baseline was 2/3 as well, so it is within noise. The
firmer result is fetches.

## Full comparison: main against v1

7 tasks (`t4`, `p1`, `p2`, `p3`, and controls `p4`, `t9`, `t3`), 3 runs, both models, Claude Code
2.1.316, no invalid run.

| | Sonnet before | Sonnet v1 | Opus before | Opus v1 |
|---|---|---|---|---|
| Skill loaded | 13/18 | 17/18 | 18/18 | 18/18 |
| Correct verb | 17/21 | 21/21 | 21/21 | 21/21 |
| Monitor or Cron fetches | 4 | 0 | 2 | 0 |
| Help hops | 7 | 7 | 6 | 8 |
| Guidance tokens per run | 3,960 | 4,200 | 4,685 | 4,637 |
| Gate | | FAIL | | PASS |

Sonnet fails the gate on tokens alone: it now loads the entry skill on `t4` and `p2`, the point of
the change. Without those two tasks its mean fell, 4,478 to 3,979, mostly `p4` loading the skill
less, which is noise.

Controls held on both models: `p4`, `t9` and `t3` lost no verb and no skill.

## What v3 did not get

The budget ran out, so **v3 has no full side**. Run on v3: Sonnet `t4`, `p2`, `p3`; Opus `t4`. Not
run on v3: `p1` on either model, `p2` and `p3` on Opus, and the controls. The controls test the cut,
which v1 and v3 share, but the v3 clause itself was not run beside them.

Against the same tasks of the before reports, `make guide-eval-compare`'s check on cut reports:

| | Sonnet (t4, p2, p3) | Opus (t4) |
|---|---|---|
| Skill loaded | 5 to 7 | 3 to 3 |
| Correct verb | 5 to 8 | 3 to 3 |
| Fetches | 4 to 0 | 0 to 0 |
| Help hops | 5 to 7 | 0 to 3 |
| Guidance tokens per run | 3,623 to 4,500 | 4,602 to 5,247 |
| Gate | FAIL, tokens | FAIL, tokens |

Opus's `t4` gained a help hop in every run.

## Probes

Two throwaway tasks outside the repo, on the v1 build, 3 runs each, for what the task set cannot
see.

- "What does this CLI print when I run it with no flags? We can add tests for that later.": no
  subscribe on Sonnet or Opus, so "when" and "later" did not over-trigger on v1. Not run on v3.
- "Show me the projects I have in this app.": `project.list` 3/3 on Sonnet before and after, no
  page verb. Sonnet only.

## Cost

$14.78 by the daemon's count, seed threads included: before $5.10, v1 after $4.92, pilots v1 and v2
$1.88, v3 $1.48, probes $1.40.

## Gotchas

- A clause that names the verb also removes the look the model took before acting. Scores rose
  while the answer got worse; only reading the runs showed it.
- `checks_passed` on a closed PR is silent for good. The daemon could say so at subscribe time,
  which would fix this for every wording.
