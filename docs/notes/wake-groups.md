# Group wakes: one wake for a batch of children (2026-11-07)

Fourth of the wake changes. Of 70 single wakes that came while siblings still worked, 40 turns
ran no tool and 3 started or messaged anything: 1.87M cached tokens for nothing. The batch window
only joins wakes within a second. `thread new --notify-group <name>` does what `--notify` does,
except that a child's plain settle waits until no thread of the group works.

## Decisions

- **Opt in, per batch.** The daemon cannot know that a piece unblocks the next: Ember's overlap runs
  start four workers when a base branch lands. Plain `--notify` stays for chains.
- **Nothing that needs the parent waits**: a prompt, a question, an error, a current blocked or
  failed report. A `thread ask` is no settle at all. The other members stay held, and come when
  the group settles.
- **Hold at delivery, release on any commit.** Like a lead's wake (`subscriptions_hold.go`), and from
  the same hook, so whatever stops the last working thread lets the others go: it errors, crashes
  or is archived. The last thread's own wake is not held, so the batch window joins all of them.
- **The group lives in the subscription's `args`**: no migration, and it survives a restart. Held
  wakes do not, like a lead's: a restart's notice wakes the subscriber.
- **Ember keeps per-worker wakes.** It closes tasks one at a time and starts dependent ones as they
  land, so `ember task start` takes no group.

## Results

Against the same tasks without groups, 3 runs each. Opus took `--notify-group` in all 6 fan-out runs.

| | `t6` before | `t6` after | `t10` before | `t10` after |
|---|---|---|---|---|
| Wakes | 6 | 3 | 9 | 3 |
| Wake turns with no tool | 3 | 0 | 6 | 0 |
| Runs with a conflicting pair | 3 of 3 (the known one line) | 2 of 3 | 0 | 0 |
| Cost | $2.70 | $2.46 | $2.98 | $2.66 |

The whole stack against main, on the six shared tasks: cost $12.46 to $11.66, parent reads 22 to 7,
child reports 49 to 0, guidance tokens 6,576 to 6,495, and the merge gate passes.

## Gotchas

- A child that settles before its siblings exist goes at once: nothing else of its group works yet.
  Start the batch before ending the turn, as the skill already says.
