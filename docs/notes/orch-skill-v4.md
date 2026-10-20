# Orchestrate skill v4 (2026-10-20): round 3 of the orchestration battle test

Round 3 ran ten experiments (Opus 5.5 high drivers, Opus 5.5 low orchestrators, Sonnet
5.5 low children, dev build of main at 5d6e3a4a) against an isolated daemon, then A/B
tested the skill text this change ships in a second daemon built from it (four runs that
repeat e1, e2, e6 and e8+e7). Skill text and its test only; the daemon and CLI gaps the
round found are listed at the end for their own PRs. The full report and every
transcript lived in `/tmp/cf-exp3/results` (REPORT.md, e1-e10, the v4 A/B under
`/tmp/cf-exp3-v4/results`); this note keeps the evidence that matters.

## What the old text got wrong (and the evidence)

- **Conflicts designed in.** In e1 round 1, e3, e6, e8 and e10 every child was told to
  add its code at the same spot ("append at the end of store.go", "the case right after
  list"), so every pair of branches conflicted (e8: 10 pairs of 10). The old rule said
  shared files go to one child and to state the shared design; it did not say how. The
  same orchestrators got it right on a second try (own test files, distinct anchors, one
  README owner).
- **Work in the project's shared checkout.** e8's orchestrator A ran `git switch -c` and
  merges in the project checkout that orchestrator B also ran in (B's branch moved under
  it); e10's did a "one more" task there itself, following "a single task: do it yourself
  in your checkout", and pushed a stray branch.
- **Wake turns talk.** Every experiment: 3-14 line updates to the user on a partial
  batch, often with a promised later check; e3's eleven approval turns each ended with a
  paragraph and a repeat of the open question ($0.39, three times the child's cost). The
  rule lived only in wakes.md, which was read late or never.
- **Leads** never posted `thread report progress` (e2: 0 of 3 turn ends, so the daemon's
  hold never fired and the parent got a wake per worker settle) and skipped the final
  report once; the parent's lead prompt did not name `thread report` because leads.md
  said not to copy rules into the prompt.
- **Review** relayed a child's own "untested" caveat instead of sending it back (e7).
- **Budget**: raised a user-set cap unasked for a follow-up (e4); "let it finish" after a
  stop that came after the report invented new work (e4).
- **Handover**: the subscription on a handed-over child stayed, so the user's steers
  woke the orchestrator (e6); "archive everything" took the handed-over thread (e6).
- **Overlap check**: cumulative instead of pairwise (e8, one wrong claim), by inference
  from report file lists (e4), with a fixed `/tmp/mergecheck` clone (e3) or a temporary
  `git worktree add` in the user's repo (e10, e9); never redone when a branch changed;
  never including other orchestrators' branches (e8).
- **Archive with a blind `--yes`**: e9's orchestrator archived three children four
  minutes into their checks; nothing was pushed. Every example carried `--yes`.
- **`send --wait` in a user turn** locks the user out: e9 run 2 queued "are you there?"
  for 3 min 24 s behind a foreground `send --wait` (the app said "busy"); run 1 ran the
  same wait as a background Bash task and answered in 6 s.
- **Children**: `git add -A` committed the built binary (e4); a child reported done for
  an edit its script never made (e10); re-reports listed only the latest round's files
  (e7, e9); build output in a shared `/tmp` path (e7); no re-report after a user's steer
  (e6).

## What changed

`SKILL.md` (136 lines; the test's cap goes 130 → 136 with the reason: these rules earn
their inline place because the references were read late or not at all):

- Thread or subagent: a single task only "when you orchestrate nothing"; while
  orchestrating a follow-up is another child; never `git switch`, merge or push from the
  project checkout; a trial merge is `git merge-tree --write-tree`.
- Step 1: the created line's `cf/<slug>-2` note (take the branch from the report, never
  the name); the conflict recipe (own new files, distinct anchors, one README owner);
  stage only changed files; `git diff origin/<default> --stat` against the claim; report
  again after any later message; pointer to `patterns.md` §0.
- Step 2: `send --wait` blocks the user (prefer `--notify` or a background task); a wake
  turn on a partial batch ends silently or with one line.
- Step 4: pairwise, other open threads' branches included.
- Step 5: `thread archive` without `--yes` first; exit 2 means a working thread would be
  stopped: ask the user.
- Leads: the prompt line "read its reference/leads.md first; finish with `thread report
  done` listing each worker"; "if you are a lead, read leads.md now"; `thread reports
  --descendants-of <lead>` before presenting.
- Cleanup: offer `project branch delete` for merged branches; if it refuses, tell the
  user, never raw git.
- Conventions: a created thread's LAST step is `thread report`, again after each later
  message; ask an open question once.

References: `patterns.md` §0 "The child's prompt" (the checklist, including the
spots-in-a-switch limit, zsh/BSD sed), §2 `--yes` note, §2b stack only when needed +
restacking after a review fix, §3 review criteria + `send` for `--notify` children +
the user-lockout warning, §5 silent approvals + denied-edit retry, §6 budget as a total
+ stopped-after-report, §8 pairwise `merge-tree` loop + diff vs report + redo + no clones
in the project repo. `wakes.md`: "said more" with a fresh report is a recap; "Interrupted";
a shorter "After the app restarts"; "A child you handed over" (unsubscribe). `sidebar.md`:
unsubscribe on handover, archive only on the user's say-so, re-subscribe when taking
back. `leads.md`: the real wake header, worker prompts wake the lead, LAST step, whole-
tree cost.

## A/B (v4 build, same scripts)

| old | v4 |
|---|---|
| e1: every pair conflicted | w1: 3/3 and 6/6 pairs merge cleanly; w3, w2 clean; w4 store.go 10 → 0 (main.go still 10/10 with five commands on one anchor: §0's spots rule came from this) |
| e8/e10: integration and a follow-up done in the shared checkout | w1: 4th child; w4: integration child in a new worktree; checkouts untouched |
| e2: lead progress report 0/3 | w2: 2/2, "wake held" ×2, parent wakes 5 → 2, turns 8 → 5, final report complete |
| e6: subscription kept; handed-over thread archived | w3: unsubscribed, direct steer woke nobody, "archive everything" left it |
| e7: caveat relayed | w4: findings sent back with `send`, re-tested |
| e8: cumulative check | w4: 15/15 pairs right |
| partial-batch wake turns: paragraphs | one line in w2, w3, w4 and 2 of 3 in w1 |

Cost: w1 $1.24 vs e1 $2.03, w2 $0.79 vs $0.90, w3 $0.67 vs $0.76, w4 $1.84 vs $1.43
(review round added).

## Daemon and CLI gaps for their own PRs (ranked; details in the round's REPORT.md)

1. `--descendants-of` (list, reports, archive) leaves out removed tombstones even with
   `--all`, and their cost; `--created-by --all` has them (e4).
2. `thread archive --id X --yes` toggles: an archived thread is unarchived, exit 0 (e6).
3. The lead hold (`heldLeadWake`) needed a `progress` report (e2); shipped meanwhile in
   #276 (`ember-fixes-1-wakes.md`): any settle of a lead is held while a worker runs, and
   such a lead counts as working. This note's A/B ran before it; the v4 lead text still
   matters for the progress report (`thread reports`) and the final report.
4. Interrupt wakes say "idle: at prompt" with no reason, `last_message` or who; the tool
   call stays `[running]`; `thread interrupt` on an idle thread prints success (e6, e10,
   w3).
5. A send to an archived child unarchives it without restoring the creator's deleted
   `--notify` subscription; archiving a busy thread fires its wake before deleting the
   subscription (e9).
6. `project branch delete` runs `git branch -d` against the stale local default branch
   and refuses branches merged into origin/<default> (w1).
7. A user message during `thread wait`/`send --wait` is unseen until the wait returns
   (e1, e9): return early with its own exit code.
8. Wake batching: a 1 s window misses siblings 1-3 s apart and never coalesces during a
   busy turn; two messages both said "All 6 settled" (e1, e5, e8, e10).
9. "said more after its report" on every wake (Sonnet always writes a closing line).
10. Orchestrator status: attention blips after each approval turn; a hidden child's
    pending question is invisible in the parent's status word (e3).
11. `thread new` is silent about `cf/<slug>-2`; duplicate open names (e8, e10).
12. A child with a live background shell counts as settled; no shells in `thread get`
    or the wake (e10).
13. `thread respond` does not show the next pending request's input (e3).
14. `thread list --project ""` lists every project; no "my project" default (w2 and
    four orchestrators guessing the id).
15. Smaller: budget below spend accepted silently; interrupted turns show 0 tokens;
    restart wake lists children twice; `thread read` ordinal order; archive output hides
    the cascade; `you:` for every sender in a child's log; `[hidden]` marker missing;
    cleanup's declined-stage text; `commands.md` lacks `--descendants-of`.

## Gotchas

- Sonnet 5.5 low finishes a `todo` feature in 15-45 s: experiments that need a mid-flight
  window must slow the children (e9's `stress.sh` sleeps 240 s) or add rounds.
- Items placed mid-turn carry `placedAfter`; a miner that takes the first non-meta key
  as the item kind must skip it (cfmine.py did not, at first).
- The experiment scripts expected `thread wait` after a roll-up to exit 1; it exits 0 at
  once because `--after` defaults to the latest message, which already has a reaction.
