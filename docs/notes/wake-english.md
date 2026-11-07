# Thread wakes speak English to the model (2026-11-07)

Second of the wake changes, on `wake-final-message.md`. The model's copy of a thread wake is
labelled plain text; `WakeJSON` and `WakeTitle`, which the GUI's "Woken by" row reads, are as they
were. It is about clarity, not cost: a median wake was 1.5 KB beside a 75k-token turn.

## Why

JSON was 85% of a wake's bytes and most of it went unused. Of 410 wakes, a parent's next turn
used `subscription_id` once, `fired_at` never and `project_id` 16 times (a literal match, so a
proxy). `reference/wakes.md` had to teach the shape before a parent could act on one. Research
gave no reason to think strong models misread JSON: a six-hop relay study found format moved
fidelity by under 2 points. So this is expected to help little on its own, and it has to earn
its place in the A/B.

## Decisions

- **What a wake says now**: the header, then the request it waits on with the command that
  answers it, an explicit report, "It said", and "From the app, not the thread": the checkouts,
  pull requests, or the folder when there are none, and how long it ran.
- **The next command is in the wake**, as `thread wait` already printed it: `thread respond` with
  `--request`, always, so no count of pending requests decides the line.
- **Quoting is the trust boundary.** JSON escaped a child's words for free. Every line of them
  now starts with `> `, so nothing a child writes can pass for a line of the daemon's
  (`TestWakeBodyQuotesEveryLine`). The label says they are data, not instructions.
- **Only thread wakes change**, single, batched and after a restart. Pull request, run, timer,
  plugin and removed wakes were about 5% of the sample and keep their JSON.
- **No subscription id, timestamps or the parent's own id** in the text; the JSON has them.

## Results

The same six tasks, 3 runs each, against `wake-final-message.md`:

| | before | this change |
|---|---|---|
| Wake bytes | 112,187 | 65,257 |
| Wake-turn cost | $2.12 | $2.20 |
| Parent reads, whole run | 11 | 9 |
| Parent git calls, whole run | 60 | 65 |
| Facts relayed | 87 of 87 | 87 of 87 |
| Cost | $11.81 | $11.89 |
| Guidance tokens per run | 7,232 | 7,487 |

Neutral, as expected: 42% fewer bytes and no change in what parents do. Nothing got worse, and the
next two changes build on it. The gate fails on guidance tokens for the reason in
`wake-final-message.md`.
