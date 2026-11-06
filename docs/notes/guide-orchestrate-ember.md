# Orchestrate and Ember A/B

The last step of the guide rework: which parts of the orchestrate and Ember skills Opus 5.5 at
medium effort still needs. Opus decides, since Sonnet 5.5 only ever runs as a worker.

## Verdict

- **A, today's text:** the baseline. Clean on every score.
- **B, a tighter orchestrate skill:** not shipped. It cut guidance hard (`t10` 12,800 to 6,781
  tokens, `t6` 10,027 to 7,182) and kept conflicts at zero, but children stopped being told to
  report again after a later message. The orchestrate skill is unchanged.
- **C, Ember without loading orchestrate each epoch:** shipped. Same results, lower cost, and a
  rule Ember's workers never got before now reaches them.

No budget number moved: no body shrank, Ember's grew inside its row, and orchestrate is as it was.

## The harder task

`t6` proves little: two flags split across files and one thread started. `t10-overlap` and
`ember-overlap` ask for four subcommands from a CLI whose switch has three spots, with one usage
line, one README list and one changelog. Each runs alone in its own home (Ember is one thread per
home, and this keeps the fixture and cheaper workers from the other tasks, whose before side stays
valid), with Sonnet 5.5 low workers. `t10` starts in the project's own checkout, so working there
is a mistake it can make. The harness now records the origin's branches, every pair's merge and
the checkout's state, which used to go with the scratch folder.

The first prompt was wrong. It told each branch to list itself, so 6 of 6 pairs conflicted on
today's text and no trim could look worse. The final prompt says the lists "must end up listing
all four" and "I will merge the branches myself, in any order", and today's text then gives zero
conflicts. That round is the $1.96 pilot below and is in no table.

Against the $4 budget: the root thread peaked at $0.64 on `t10` and $0.82 on Ember. A run is $0.85
to $1.28.

## Hand-read scores

Three runs a side. B's and C's columns are the full side's; the candidate round agreed unless noted.
`t6` and `ember` on side A have no `git.txt`, so their conflicts come from the transcripts.

| | `t6` A | `t6` B | `t10` A | `t10` B | `ember` A | `ember` C | `ember-overlap` A | `ember-overlap` C |
|---|---|---|---|---|---|---|---|---|
| Pairs that conflict | 0, 1, 1 of 1 | 1, 1, 1 of 1 | 0 of 6, all runs | 0 of 6, all runs | none among its own | none among its own | 0 in all runs | 0 in all runs |
| Shared checkout written to | no | no | no | no | no | no | no | no |
| Briefs lacking the file split | 0 of 6 | 0 of 6 | 0 of 12 | 0 of 12 | 0 of 3 | 0 of 3 | 0 of 17 | 0 of 16 |
| Briefs with "report again" | 6 of 6 | 6 of 6 | 12 of 12 | 4 of 12 | 0 of 3 | 3 of 3 | 0 of 17 | 15 of 16 |
| Partial wake turn, characters | 63, 71, 71 | 48, 71, 52 | 61 to 66 | 46 to 77 | none | none | 74 to 224 | 100 to 219 |
| Final reply, characters | 1,564 to 1,767 | 1,707 to 1,955 | 1,767 to 1,961 | 1,859 to 2,247 | 455 to 492 | 400 to 435 | 775 to 847 | 612 to 885 |
| Cost per run | $0.82 to $0.95 | $0.78 to $0.85 | $0.85 to $0.92 | $0.86 to $0.97 | $0.54 to $0.60 | $0.48 to $0.52 | $1.18 to $1.28 | $0.94 to $1.17 |
| Finished | 3 of 3 | 3 of 3 | 3 of 3 | 3 of 3 | 3 of 3 | 3 of 3 | 3 of 3 | 3 of 3 |

- `t6`'s conflict is one line both flags must change. Every run told the user. 3 of 3 against 2 of
  3 is within noise.
- The briefs Ember's "report again" misses are its check workers, which push nothing.
- Every overlap run found a real design: a shared base branch the pieces stack on, a command
  registry, or byte-identical edits to the shared files. None gave two workers one spot.
- Ember's partial wake turns are longer because they do more: the base branch landing starts the
  next four workers.

## B: why it did not ship

B moved `patterns.md` §0, the child's checklist, into `SKILL.md`, cut the step 1 pointer to it and
put the batch check inline, so a routine run need not open `patterns.md`. It passed every pin.

The rule "report again after any later message" stayed in B's text, but in `t10` it reached 4 of
12 briefs, and in the candidate round 0 of 4, against 12 of 12 on A. A child gets this rule from
nowhere else, and it came from real failures (`orch-skill-v4`: no re-report after a user's steer).
So a run shows Opus does not keep the behaviour, which is the bar. `t6` kept it (6 of 6). Reading
the checklist twice, in `SKILL.md` and again in §0, may be what carried it, but that is a guess.

A fix needed `t6` and `t10` rerun, about $5 against $2.83 left. The idea is worth another try:
B's saving is real, and only this one rule was lost. Say the rule in the example `thread report`
line of step 1, then retest.

## C: what changed

Ember loaded 9 KB of orchestrate every epoch and, on `ember-overlap`, usually `patterns.md` too. It
now loads orchestrate only before a lead. Leads still load it themselves, and `PROJECTS.md` still
names its path. `rules.md`, the Ember skill and `RenderSkills` say so.

Moved into Ember's skill, because Ember got them only from orchestrate:

- The conflict recipe: own new files, distinct anchors, one owner for a list or README, and what
  to do past a switch's spots (`orch-skill-v4`).
- Stage only changed files, check `git diff origin/<default> --stat`, report again after any later
  message.
- A partial batch's wake turn is one line, and `report_stale` means read `last_message`.
- `thread send` never with `--wait`.
- Never name a worker's branch; take it from its report. The candidate round showed why: without
  this line, Ember told workers to `git push origin HEAD:add-shout`, so the pushed branch differed
  from the worktree's (5 of 6 briefs). With it, 0 of 16.

Cut from the skill, each still in `rules.md`, which is Ember's system prompt:

- "Never search the disk": `rules.md` has it, with `find /` and `mdfind`.
- Why only the last text shows.
- "Never retry a failed or blocked piece without asking".
- That a wake can come mid-turn.

New pins in `rules_test.go` hold the moved rules in both skills. Nothing was loosened and no pin
blocked a cut.

**One trade to know.** The task asks whether it all fits together. On A, all 3 runs started a worker
to build the merged result. On C, 2 of 4 did (the candidate and `r3`). The other two reported "no
text conflicts", said nobody had built all four, and offered that build. Both are honest and follow
Ember's rules. It costs the user a follow-up, and it is also why C is cheaper there.

## Gate

`make guide-eval-compare` on the composed reports: PASS. Skill 51 to 51, verbs 63 to 63, guidance
6,605 to 6,020 tokens per run, cost $21.16 to $20.26, always loaded 1,473 unchanged.

**This is not a fresh full side on the final tree.** The full side ran once, on B and C together,
and B was then dropped, with no money for another. The composed "after" is:

- 16 tasks and both Ember tasks from that full side. Only `t6` and `t10` touched orchestrate, and
  Ember's files are byte-identical to the final tree.
- `t6` and `t10` from the before side, because their text is main's. They were not rerun.
- `p2` rerun on both sides.

So the gate shows C changes nothing it can see. It shows nothing about `t6` or `t10`.

`p2` had dropped 3 of 3 to 0 of 3: `cli/cli#14957` merged at 16:33 UTC between the two sides, and
all three runs rightly said so and set no reminder, as the README predicted. It now watches
`#13505`, idle since May, and both sides ran that, 3 of 3.

The guidance fall is mostly Ember's and overstated: the scorer has no size for Ember's own skill,
which is outside the thread skills folder. That skill grew 642 bytes, about 240 tokens a load, against
the 3,652 tokens of orchestrate it no longer reads, and more when `patterns.md` was read too.

Failed CLI calls rose 13 to 17, none in these skills: `t4` is 2 of them (the `#590` subscribe
refusal, a daemon change newer than the before side), and `t7` and `p5` one each.

## Spend

| Round | Cost |
|---|---|
| Pilot, first prompt | $1.96 |
| Side A, new tasks | $6.34 |
| Candidate B and C, one run each | $3.48 |
| Full side, 21 tasks | $20.39 |
| `p2` rerun, both sides | $1.43 |
| **Total** | **$33.60** |

Against a $35 stop. `MAX_COST` goes from 18 to 24: a full side now costs about $20.

## What was not read

- The 16 other tasks by hand (`p2` was read, for its drop).
- Workers' transcripts line by line: their briefs, git state and a scan for `git add -A`, `git
  stash` and BSD `sed` mistakes (none), not every step.
- The final side's `t6` r2 and r3, `t10` and `ember-overlap` roots were read through a filter (text,
  turn ends, brief lines), not every tool output.

## What no run exercised

The tasks are first epochs on a clean run, so C is unproven for these, and they are where to look
if Ember misbehaves: a later epoch, a lead (the new "only before a lead" path never fired), a
permission prompt or question, a stale report, a restart, a budget stop, steering, an interrupt.
Ember's skill covers each but the interrupt, which only `wakes.md` explains.

## Gotchas

- macOS has no `timeout`.
- Threads leave scratch in `/tmp`, outside the harness's cleanup. A `t10` run in the full side found a
  `/tmp/greet-shared.*` folder from an earlier run and spent about two minutes on it.
- `t10`'s 802 seconds in the candidate round was a child's `ls` hanging on this Mac's `eza` alias.
