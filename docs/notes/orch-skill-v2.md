# Orchestrate skill v2 and the routing prompt line (2026-10-19)

Ships the skill text the 2026-10-18 Haiku 5.5 orchestration experiment A/B-tested (wave
3, findings A1-A10 and C10 of its report), with the amendments wave 3 asked for. Skill
text, the appended system prompt line and their tests only; no CLI or daemon change.

## What changed

`internal/skills/files/code-foundry-orchestrate/SKILL.md`:

- **Description in the user's words** (531 characters): parallel, split up, separate
  branches or PRs, subagents/helpers/agents for work that edits files; a single change
  stays in place; native subagents for read-only research. v1 fired for 1 of 5 phrasings
  that did not say "thread", v2 for 3 of 5 (W2E vs W3A).
- **Thread or subagent**: a single task is done in place; the Agent tool never with its
  worktree isolation; never `git worktree add` under the worktrees directory or make
  `cf/...` branches by hand.
- **No cleanup at start** (W2E: one orchestrator's start-up cleanup deleted another's
  3-second-old worktrees). Cleanup only when the user says a PR merged.
- **Child prompt**: owned files, `git push origin HEAD` (not `-u`: sibling worktrees share
  one `.git/config` and collide on its lock, W3A), `report done --data '{"branch","files"}'`.
- **Pick ONE wait mechanism**, including: from a wake turn, answer or follow up a
  `--notify` child with `thread send` WITHOUT `--wait` and end the turn; `send --wait`
  there held back the other children's wakes for 33 s in W3B.
- **Prose questions**: the v2 "use AskUserQuestion" sentence is gone (W3B read "the user"
  as the human and told its child to ask in prose). Instead: a child that finished without
  a report may be asking in prose; `thread read` it, answer with `thread send --id`.
- **Budget stop**: raise AND send "continue". **Quiet intermediate wakes**: one short
  line unless something needs the user. **Batch overlap check** before the roll-up.
- **Archive after the user accepts or merges**, not after the first report (archiving
  deletes the wake subscriptions). patterns.md §2 used to archive right after the
  summary; it now says the same as SKILL.md step 5.
- **Leads**: a parent tells a lead "You are a lead: use the code-foundry-orchestrate
  skill" instead of copying rules into its prompt (W3C: the top transcribed the section,
  one lead never loaded the skill). Leads keep: no cleanup, `report progress` before
  ending a turn with workers running, children in the final `--data`.
- `--request-id`: a key whose thread was removed starts a new thread (E4 F7).
- Kept main's additions since the experiment's base (91dc68ed): the PR-wake bullet in
  the Wait step, the plugin wake-sources convention and patterns §4.

`ThreadPrompt` (`internal/store/thread/workspace.go`) gets a third sentence, because
rules that live only behind the skill trigger never reach a thread whose skill does not
fire (W2E P1/P5, W3A P3): "Work the user wants split up, run in parallel or landed on
several branches goes through code-foundry-orchestrate (child threads in new worktrees),
never the Agent tool, hand-made worktrees or hand-made cf/ branches; the Agent tool is
for read-only research."

## Decisions and gotchas

- The skills test capped the orchestrate description at 400 characters and every
  SKILL.md at 120 lines. Now per skill: orchestrate 600 / 160 (152 lines); help and
  plugin unchanged. The tested rules stay in SKILL.md rather than moving to
  patterns.md, which the model reads only on demand.
- Not described, since the CLI cannot do them yet: an ordinal printed by `thread send`
  (v2 had "`thread wait --after <#N>` with the ordinal `thread send` printed"; dropped),
  a "removed" wake, richer wake fields. Later PRs add them with their text.
- Not taken from the wave-3 candidates: "even when each change is small", positive owned
  files lists, coordinator children without `--new-worktree`, siblings sharing a file via
  `--base`. No evidence yet that they are needed beyond Haiku.
- The system prompt line is static (cached), so the new sentence costs nothing per spawn.

## End to end

Daemon built from this branch, `CODE_FOUNDRY_HOME=/tmp/osv2-home`, Haiku 5.5 medium, a
scratch clone of the todo template with a local bare origin. W2E's P1 prompt, created by
the user (`--created-by ""`):

```
#1 you: Do these three in parallel: fix the Store.Remove bug with a regression test, add unit tests
   for internal/format, and fix the typos in README.md and docs/design.md. Push each as its own branch
   to origin (no GitHub remote, no PR) and tell me the branch names.
#3 claude: This is three separate branches, so I'll follow the code-foundry-orchestrate workflow rather
   than doing it by hand.
#4 tool Skill [done] {"skill":"code-foundry-orchestrate"}
#12-14 tool Bash: 3x code-foundry thread new --project b533c965d6eb --new-worktree ... --notify
   --request-id ... --prompt "... git push origin HEAD (do not use -u; ...). Finish with: code-foundry
   thread report done ..."
#16 claude: I started three child threads ... They run in parallel and will wake me when they report.
#17 turn end: success, 27.2s, $0.0075
#18 wake: Thread "Fix typos in docs" ... Report: done — ...
#20 tool Bash: code-foundry thread reports --created-by s-541edbe5ed23
#21 claude: The docs thread is done ... I'll wait for their wakes and report the full batch when they finish.
#22 turn end: success, 5.7s, $0.0011
#23, #24 wakes (format tests, Store.Remove)
#30 tool Bash: git diff --name-only origin/main...origin/$b per branch; pairwise git merge-tree --write-tree
#31 claude: All three branches are pushed to `origin` ... They touch disjoint files and each pair merges cleanly.
you: Looks good, I accept all three. Wrap up.
#35 tool Bash: code-foundry thread archive --ids s-d8d99a60f2ee,s-7f38373960ef,s-5e3a336924be --yes
#36 claude: ... I didn't run worktree cleanup, since nothing has been merged.
```

Skill fired first; `--notify` with no `thread wait` anywhere (0 of 9 tool calls); no
cleanup (daemon log has no worktree removal); archive only after "I accept"; all three
children pushed with `git push origin HEAD`. One known slip: wakes #23 and #24 folded
into one turn whose line still said Store.Remove was running (burst coalescing, C7, a
daemon fix).

The two phrasings that never loaded the skill in W2E/W3A, run on the same daemon, now
do, and both cite the new prompt line in their first message:

```
P3 #3 claude: This asks for two changes on separate branches, which goes through the orchestration
   skill rather than hand-made branches.          (2 child threads, cf/ branches by thread new)
P5 #3 claude: This is parallel work that lands on separate branches, so I'm loading the orchestrate
   skill. It sends each piece to its own child thread rather than using the Agent tool.
```

P3's roll-up also ran the overlap check against P1's branches on origin and kept its
children open "until you've accepted or merged the branches". The daemon log shows the
new sentence in every spawn's `--append-system-prompt`.
