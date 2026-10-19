# Orchestrate skill v3 (2026-10-19)

Ships the skill text that wave 2 of the 2026-10-19 orchestration battle test A/B-tested
(report section C, wave-2 runs W1-W4 under the v3 patch), with the corrections the
report lists, plus item A1's "after a restart" paragraph and A6's lead rule. Skill text,
one guide line and their tests only; no CLI or daemon change.

## What changed

`internal/skills/files/code-foundry-orchestrate/SKILL.md` (159 lines, cap 160):

- **Before fanning out**, `thread list --project <id>` and tell the user about open
  threads (other than yours) that already cover a task (W3 found all 10 existing
  branches; "other than yours" because W3's orchestrator twice took its own row for a
  rival). Moved to the head of step 1: W1 ran `thread list` without `--project` when the
  sentence sat at the end of the child-prompt paragraph.
- **Child prompt**: shared files (README, changelog, a package's one `_test.go`) go to
  one child or to the parent after the merge; the shared design in both prompts when two
  children must change one file (W1's merge worked where E1's broke); `git push origin
  HEAD`, never `git stash`; a PR only when `origin` is on GitHub (`blocked` 9/12 in E7 →
  0/7 in wave 2); report as the LAST step with every caveat in the summary (the parent
  sees the report, not the prose after it); `--base origin/<branch>` for work that
  builds on a sibling's pushed branch.
- **Questions**: answer every pending request before relaying a child's question to the
  user as plain text (W2: 0 s stall against E3's 198 s). Corrected: "the child still
  asks with its own question tool", since W2 applied the plain-text rule to the child and
  the wake lost its `options`.
- **Wake turns**: `--all` on the batch check, wakes can arrive seconds apart, end
  silently or with one line, do a check now or never promise it, do not message a
  finished child only to inform it, a send to a working child is read at its next tool
  call (`interrupt` first to stop it), `thread rename --id <id> --name` (corrected from
  W4's positional form) when a follow-up changes the task.
- **After the app restarts** (new, A1 / E8 §4.2 and the good recovery in §3.6):
  `thread reports --created-by $CODE_FOUNDRY_THREAD --all` plus `thread list --created-by`
  (reports carry no thread status); a child in `error (interrupted)` with reason "daemon
  stopped" lost its current turn only: check its worktree, then `thread send --id <child>
  "the app restarted; continue"`; subscriptions survive, do not re-subscribe.
- **Step 4** reads both diffs of a file two branches touch and says whether they fit
  (same flag parsing, same types), not only whether git merges them.
- **Leads**: `report progress` after the `thread new` calls returned, with the ids they
  printed; the final report lists every worker's id, branch, status and concerns; the
  parent runs `thread reports --created-by <lead>` before presenting; a lead gets no new
  worktree. New (A6): a lead's progress settle while workers run does not wake the parent;
  the daemon holds it and wakes the parent when the lead's work is done or a worker needs
  someone. cf/orch-wakes-content implements that; the text states the behaviour and lands
  with or after it.

`reference/patterns.md` gets the worked sections the line cap pushed out of SKILL.md,
each with one pointer in SKILL.md (a test checks both ends):

- §2b a branch built on a sibling's (`--base origin/<branch>`).
- §5 A supervised child: tell it it is supervised, Edit/Write for files, commit and push
  as separate commands (W2: 5/5 edits via Edit/Write); `respond --id <child> allow
  --request <id>`; pending requests before relaying a question; never tell a child not
  to use its question tool.
- §6 Budget stops: never raise a user-set budget unasked; raise AND send the "stopped at
  its spending limit, nothing was rejected; check what your last command did" message
  (W4: the child did not read the stop as a rejection).
- §7 Discarding a child's work: ask about the branch first, `thread remove --id <id>
  --yes` (no interrupt), then `project worktree remove --project <id> --path <wt> --yes`
  (`--project` is required inside a thread, W4 §4.2) with `--delete-branch` on a yes.
  Asking first fixes W4 §4.3, where the branch question came after the worktree was gone.
- §4 keeps the GitHub poll timing and the other `--until` values that left SKILL.md.

`internal/guide/guide.go`: the report line says "as your last step, every caveat in the
summary". The guide sits at its 29,000-byte cap, so the proto pointer in "Discover more"
was shortened by the same amount.

## Decisions and gotchas

- SKILL.md was 183 lines with the v3 patch applied as is. The trim kept every v3 rule
  that the W1-W4 scorecards marked FOLLOWED or effective in SKILL.md; only the rules for
  situations the model is already in when it needs them (supervised mode, a budget
  stop, a discard on the user's say-so) moved behind a pointer. Conventions were
  condensed (the `--until` list now lives in commands.md and patterns §4).
- The description is unchanged: it fired on 5/5 phrasings in E7/W3.
- Not addressed by text, per the report: "end intermediate wake turns silently" and
  "look at the whole batch" were still ignored by Opus low (W1, W2); they need A2/A6.
- The patch script targets an installed copy; it was ported by path, and its result
  then edited by hand (the repo's v1 text was byte-identical to the experiment's backup).

## Verified

- `make check` green; the skills test checks the 160-line cap (159), the description
  length, user-invocable false, and that patterns.md has §5-§7 and SKILL.md points at
  each. The guide test's 29,000-byte cap holds.
- Live: an isolated daemon built from this branch installed the skill (159 lines,
  patterns.md with §5-§7) into its claude dir. One Haiku 5.5 medium orchestrator in a
  scratch `todo` project with a local bare origin, given "Two branches, I'll merge them:
  add JSON output; fix the README typos" (`thread read`):
  the skill fired on the first tool call; it ran `thread list --project <id>` before
  creating; both prompts said which files each child owns (README to the typo child
  only, the shared "No JSON output" line left for after the merge), `git push origin
  HEAD`, never `git stash`, a PR only if origin is on GitHub, and report as the LAST step
  with caveats. Both children reported `done` with caveats ("No PR opened because origin
  is a local path"), none `blocked`; the orchestrator's intermediate wake turn was three
  sentences, and the roll-up ran name-only diffs, `merge-tree` and the tests, relayed the
  JSON child's caveat and left both threads open. Cost $0.008 orchestrator.
- Not exercised live: the restart paragraph, the quiet lead rule (needs
  cf/orch-wakes-content), §5-§7.
