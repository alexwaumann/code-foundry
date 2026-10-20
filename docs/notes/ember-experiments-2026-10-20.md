# Ember battle test, round 1 (2026-10-20)

This is the first real-use run of Ember after #269, #270 and #272 (main at `ea2441c7`).
It covers 17 experiments: the 12 in the brief, then five more where something looked weak
(timers, a worker's question, two quick messages, "do it yourself", merge then clean up).
Nothing was fixed in this round. The findings are at the end, ranked and split into
daemon, skill/prompt and GUI.

## Setup

- `make build`, then the daemon from this worktree on a scratch home:
  `CODE_FOUNDRY_HOME=/tmp/ember-exp-home CODE_FOUNDRY_BIN=<worktree>/bin/code-foundry
  bin/code-foundry daemon --dev`. Every CLI call went through a `cf` wrapper that pins
  that home and binary.
- Settings:
  - `ember.model claude-opus-5-5[1m]`, `ember.effort low`;
  - `ember.worker_models claude-sonnet-5-5[1m]`, `ember.worker_effort low`;
  - `threads.default_model` and `threads.naming_model` also Sonnet 5.5, so a model the
    hook missed would still not be another model. `threads.default_effort` stayed
    medium, so a miss would show up as medium. None did.
- Two scratch projects under `~/scratch-ember-exp/`, each with a local bare `origin`:
  - **tally**: a Go `wc` clone (`cmd/tally`, `internal/count`, `internal/format`, three
    test files, README);
  - **notes-api**: a dependency-free TypeScript HTTP API run by Node 24. It has six
    handlers in `src/handlers/`, a router, an in-memory store and one test file with
    `node --test`.
- `cf ember enable` gave thread `s-41e4241398cf`, epoch 1.
- I talked to Ember with `cf thread send --id <ember> "…" --wait --for 20m`. Then I read
  with `thread read` / `thread items --json`, `ember board`, `ember task list --all`,
  `ember status`, `thread reports --created-by`, `thread subscriptions` and the daemon
  log.
- GUI: Vite from this worktree on 9417 (9411 was held by another session's Vite). It ran
  in Playwright WebKit with `?daemon=…&token=…`:
  - a sampler page stayed on the start view and logged the pinned row's `data-flame` and
    line on every change (500 ms), so it never cleared Ember's attention;
  - screenshot runs selected the chat and opened the Board;
  - an audit script scrolled the whole chat and collected its text.

  Screenshots stayed in `/tmp/ember-exp-shots` and were deleted with the rest.
- Totals:
  - **$5.08** in `cf usage`: Ember (Opus 5.5) $2.99, workers (Sonnet 5.5) $2.09. The two
    consolidation calls are not counted there (see D5).
  - 22 threads: Ember, 14 direct workers and 7 under one lead. 46 Ember turns, 15 tasks.
  - 0 WARN/ERROR lines in either daemon log (before and after the E10 restart).

Durations are wall clock from the CLI. Ember's costs are the `turnCostUsd` of its turn
ends; a worker's cost is from `thread list --descendants-of`.

## Experiments

### E1 Single piece: works as designed

"In tally, add a --version flag to the CLI that prints the module version; add a test;
commit and push a branch; no PR." (06:50:16)

- The request turn took 11.7 s and cost $0.170 (6 API calls, 132.5K input tokens, almost
  all cache reads). Ember:
  - loaded the code-foundry-ember skill;
  - ran `ember task add`, then `thread new --project … --new-worktree --labels
    ember,t-421f3c67 --notify --request-id t-421f3c67`, with no `--model`;
  - ran `ember task update --thread --state doing` as a separate command.
- The worker ran on `claude-sonnet-5-5[1m]` low, in auto mode (from the hook), and
  finished 06:50:43 at $0.09.
- The wake turn (7.9 s, $0.041) ran `git fetch && git log origin/main..origin/<branch> &&
  git diff --stat`, then `ember task done`.
- Done at 06:50:56: 40 s end to end. Two replies, each with the task link once. The second:

  > `tally --version` is done and pushed to branch `cf/add-version-flag-to-tally` as one
  > commit, with no PR. The worker reports that the new test and the full `go test ./...`
  > pass. I confirmed the commit is on origin and touches only `cmd/tally/main.go` and
  > `cmd/tally/main_test.go`, but I didn't run the tests myself. … The module had no
  > version anywhere, so the worker picked `0.1.0` … That number is a placeholder, not a
  > real release version. … Do you want a different default?

The pinned row went Idle → Working (thinking) → "Working · tally: add --version flag
with test · 1 thread" (working flame) → Working (thinking, the wake) → Finished
(attention). Selecting the chat cleared it to Idle.

### E2 Three pieces across both projects, one dependent

The request (06:51:43): tally `--json`; notes-api `?sort=title|createdAt` with a test;
"Once both are pushed, update the README of each project"; branches, no PRs.

- **Split.** One parent task (`t-10eb5205`) with four subtasks: two code pieces and two
  README pieces. Two workers started at once. The first turn took 20.9 s and cost $0.089.
- **Dependency.** The README pieces stayed `todo` until both code wakes were checked.
  Then they were started with `--base origin/<code branch>` (#43, #44): the right way to
  express "on top of".
- **Round robin.** Only one worker model was allowed, so the order could not be seen.
  The counter worked: `state.json` `worker_next` went 0 → 5 over five workers. Every
  worker was Sonnet 5.5 low.
- **Wakes.** The two README wakes, 2 s apart, ran as one turn (#49 and #51 in one turn).
  So did the README-wording and `-w` wakes in E15.
- **Noise.**
  - Every code wake produced a full reply: #37 was 9 lines with bold-labelled bullets
    when 1 of 2 pieces had finished.
  - The final summary (#55) was concise and accurate.
  - Two mid-turn narration lines showed as their own paragraphs: "Still early; I'll
    redirect it." (E4) and "Now both READMEs, on top of each code branch." (#42).
- **Totals.** About 1 m 45 s (06:51:43 → 06:53:28). Ember $0.376 over 5 turns (with
  E4); workers $0.06–0.11 each.

### E4 Steering mid-flight (during E2)

Sent at 06:52:07, while both workers ran: "Change of plan for tally: call the flag
--format json (so --format=json works), not --json."

- **Reached the right worker.** Ember ran `thread --help` (it did not know the verb) and
  `thread read` on the worker. It said "Still early; I'll redirect it.", then ran
  `thread send --id s-ea34c99ac4fb "Change of plan from the user: do NOT add --json.
  Instead add a --format flag…"` and renamed the two tally tasks. 10.4 s, $0.057.
- **The worker followed it.** It reported `--format text|json` and Ember checked that.
  The board stayed coherent (`tally: add --format json flag`,
  `tally: document --format json in README`). No new worker was started.
- **Gaps.**
  - The parent task kept "tally --json and notes-api sort, with README docs".
  - The thread kept "Add --json flag to tally"; the orchestrate skill's wakes.md says to
    `thread rename` when a follow-up changes the task.
  - The branch kept `cf/add-json-flag-to-tally`. Ember said so honestly.

### E3 Impossible piece: blocked, told once, one question

The request (06:54:26): use `@acme-internal/note-schema` ^3.2 "on our company npm
registry" to validate createNote.

- **Start.** Ember's first reply anticipated the failure: "If it can't install the
  package … it will stop and report the exact error. It won't write its own validator
  or swap in another package."
- **Blocked.** The worker reported `blocked` with npm's E404 and the missing scope line.
  The daemon blocked the task with that summary as its outcome (`ember task show`:
  `[blocked]`).
- **Told once.** The wake turn (5.2 s, $0.038) only told the user:

  > The `note-schema` validation is blocked because npm can't find the package. Nothing
  > was changed or pushed. … What is your company registry URL? …

- **Afterwards.** No retry and no silent second worker. Ember kept carrying it as
  "blocked, needs the URL" through both later epochs.
- **Totals.** 35 s; Ember $0.108; worker $0.07.

### E9 Ambiguity: one focused question

"Make the project better." (06:55:28). One turn: 2.7 s, $0.014, no tools, no threads:

> Which project, and what kind of "better" do you want first? For example, more tests,
> bug fixes, cleaner code, better docs, or a specific feature. If you'd rather I pick,
> I'll have a worker review one project and propose a short list …

### E7 Lead for six pieces

The request (06:55:38): input validation for all six notes-api handlers, with a test file
per handler.

- **Lead.** "That's six handlers, so I've started a lead thread." The lead had no new
  worktree (`notes-api@main`), `--notify`, and one parent task. Its prompt said "You are
  a lead: use the code-foundry-orchestrate skill" and gave a plan: a shared helper first,
  then one worker per handler on `--base origin/<helper>`.
- **The first turn took 63 s ($0.117).** 43 s of it (11:55:41 → 11:56:24) was the search
  for `leads.md` (see S1):

  ```
  cat /tmp/ember-exp-home/residents/ember/skills/.claude/skills/code-foundry-orchestrate/reference/leads.md 2>/dev/null \
    || find / -path '*code-foundry-orchestrate/reference/leads.md' 2>/dev/null | head -1
  → /private/tmp/cf-exp3-restart/claude/.claude/skills/code-foundry-orchestrate/reference/leads.md
  ```

  Then it Read that file: another daemon's leftover copy from round 3.
- **Team.** The lead ran the helper, then six workers ($0.08–0.11 each). Each was
  verified and the result reported done. Team cost: $0.92, lead $0.26 of it.
- **Noise.** Ember was woken 6 times by the lead (#83, #86, #89, #92, #95, #98). Five
  were progress settles, each an Opus turn (~$0.016, about 1.8 s) and a visible reply:
  "The validation helper is still being written…", "Still running: three of the six
  handler workers are still going.", "`searchNotes` is done; …", "One handler worker is
  still running.", "All workers have reported; waiting on the lead's final report." Only
  one settle was held: the log has `wake held: lead still has 6 workers` once (see D1).
  The wake titles also said "All 7 of your child threads settled" while 3 of the lead's
  workers were running (D2).
- **Final summary.** It covered every piece (#102):
  - the helper branch first, then the six `cf/validate-*` branches;
  - "Nobody has merged all seven together and run the tests yet";
  - five behaviour changes (bad ids 400 instead of 404, limit max 1000, trimming,
    unknown fields 400, empty or duplicate `q`/`tag` 400);
  - the coming `listNotes.ts` conflict with the `sort` branch;
  - an offer to merge everything.
- **Board.** It showed one card with only the lead as its worker: "Idle" while its six
  workers ran. The header said "Nothing in progress", and the pinned row's "· 1 thread"
  flickered on and off with the lead's own busy state. The team never showed (G3).
- **Totals.** 3 m 40 s (06:55:38 → 06:59:18). Ember $0.27 over 7 turns.

### E8 Cancel

`--top N` was started at 07:00:20 and its reply came at 07:00:33. Then: "Stop the --top
work, we don't need it after all." (07:00:33 → 07:00:40, $0.054).

- Ember ran `thread interrupt --id <worker>` and `ember task update --state cancelled
  --outcome "Cancelled by user; worker interrupted"` (not the `ember task cancel` verb).
- The interrupt's settle wake arrived inside the same turn. Then it ran
  `thread archive --id <worker> --yes`.
- The reply was honest: "I stopped the `--top` worker before it pushed anything, so no
  branch exists on origin. … Its worktree is still on disk." `git ls-remote` agreed. The
  task shows `[cancelled]` with `worker … archived`.

### E10 Daemon restart mid-run

The `-l` flag request was sent at 07:01:03; the worker was busy 3 s in. SIGTERM went to
the daemon's own pid at 07:01:10 and a new daemon was up at 07:01:14 on a new port.

- The worker showed `error (interrupted)`. Ember's restart wake arrived at once:
  "The app restarted at 07:01 CDT; 1 of your child threads was interrupted: "Add -l flag
  to tally" … its session resumes on your next send."
- Ember ran `thread send --id <worker> "The app restarted and interrupted you. Please
  continue …"` and replied in one line (4.7 s, $0.056).
- The worker finished and Ember verified and closed the task at 07:01:55.
- The board, the subscriptions and the sampler page all recovered: the sampler logged
  `reopen port 57523`, then the same row states.

### E5 Continuity across an epoch

- **Remembering.** First: "FYI: Dana owns notes-api and reviews every change to it …".
  Ember ran `ember remember` at once ($0.034).
- **Reseed.** `cf ember reseed` at 07:02:31 took 11.2 s:
  - consolidation input 15,963 B (33 messages, 10 task changes);
  - MEMORY.md 266 B → 2,698 B;
  - prefix 19,642 B (BOARD 4.0 KB, PROJECTS 0.3 KB, RECENT 12.4 KB, 33 messages);
  - epoch 2; context reset; the next message spawned a fresh `--session-id`.
- **MEMORY.md after it.**
  - Notes: the Dana line was kept verbatim.
  - User preferences: branch + push + no PR, docs on top of the code branch, ask on vague
    asks, report claimed vs verified.
  - Projects: layouts, test commands, Dana as reviewer.
  - Open follow-ups with task ids: the blocked registry task, the merge offer and the
    behaviour changes, pending Dana reviews, expected conflicts, the `--version`
    question, the `--top` worktree.
  - A "Pushed branches" list.

  Nothing the user said was lost.
- **"What have you done for me today, and what's still open?"** 6.3 s, $0.136; the first
  turn of an epoch writes ~15K tokens to cache. The answer was accurate against the
  truth:
  - each tally and notes-api branch;
  - "the workers say tests pass … I didn't run the tests myself";
  - open items: the blocked task with the fix, two unanswered questions, Dana's review,
    the two expected conflicts, the `--top` worktree.
- **"What did I ask you to rename?"** 3.4 s, $0.031:

  > You asked me to rename the tally flag. Instead of `--json`, you wanted `--format json`,
  > with `--format=json` also working. You asked while the worker was still reading the
  > code, so nothing had to be undone. … The branch kept the old name,
  > `cf/add-json-flag-to-tally`, …

  The answer came from RECENT.md, not memory: MEMORY.md has the rename only implicitly.

### E6 Automatic epoch boundary

`ember.epoch_context_tokens` was set to 60000 at 07:03:36, with epoch 2 at 32.7K. Ordinary
work followed: the merge-the-validation-branches worker, a timer (E13), a combine-three-
branches worker, a full diff review, reports.

- **Boundary.** The turn that ended at 61.1K (07:21:35) set off a boundary at 07:21:48,
  13 s after the turn ended, with Ember idle:
  - `ember: memory consolidated … input_bytes=22733 memory_bytes=3279 messages=25
    task_changes=2 took=12.559s`;
  - `thread reseeded … epoch=3 prefix_bytes=28682`;
  - `ember status` shows "a new epoch is being prepared (consolidating its memory)" while
    it runs.
- **Still usable.** The next message, "Does the README you just showed me mention the -l
  flag?", was answered right from RECENT.md (3.5 s, $0.160, 19.2K cache write).
- **Cost of a low limit.** Epoch 3 starts at 34.1K, 57% of the 60K limit: system prompt,
  skills and a 28.7 KB prefix. At the 400K default this is irrelevant.
- **Memory diff.** New: Dana's review order, "rebase sort after validation", the
  superseded branches left on origin, the untracked `package-lock.json`, the `0.1.0`
  decision. Two oddities:
  - a doubled date in a remembered line (`- 2026-10-20: 2026-10-20: User wants to keep
    0.1.0…`; D4);
  - a wrong inference: "A teammate (alejandro waumann) pushes to tally main". The
    "teammate" commit was mine, under the user's git identity: a test artefact.

The setting was reset to 400000.

### E11 Cost and noise, the whole round

| | turns | cost | per turn |
|---|---|---|---|
| Ember, user-started | 27 | $2.07 | $0.077 |
| Ember, wake-started | 19 | $0.92 | $0.048 |
| Ember total | 46 | $2.99 | $0.065 |
| Workers (21 threads) | | $2.09 | |
| Consolidation (2 calls, Opus low) | | not in `cf usage` | 11–13 s each |

- **Per turn.** 3.1 API calls and 132.6K input tokens on average, nearly all cache reads.
  Context grew from ~22K to 65K across epoch 1's 23 turns.
- **Ember vs workers.** Ember spent more than its workers. A one-piece task cost Ember
  two turns ($0.11–0.21) against the worker's $0.06–0.11. Three of the ~6 calls in a
  starting turn are mechanical: task add, thread new, task update (D3).
- **Wakes.** 22 wake messages over 19 wake turns: 14 direct workers, one restart notice,
  one timer.
  - Most workers gave one wake.
  - The lead gave 6 (5 were noise).
  - The `-l` worker gave 2 (restart, then done).
  - The cancel's settle wake landed inside the cancelling turn.
- **Replies.** Average 676 characters, median 551. Noise:
  - 5 of 46 replies carried nothing (the lead progress wakes);
  - 2 more were mid-turn narration;
  - 5 start replies repeated "It starts from main, so it doesn't include the unmerged …";
  - "I didn't run the tests myself" (or close to it) appeared 9 times.
- **Discovery.** 9 calls of `--help`, `help` or `commands` to find verbs the ember skill
  does not name: `thread send` to steer, `thread subscribe --at`, `thread respond`
  (S2). One `find /` (S1).
- **`git fetch`.** 17 times in the user's own project checkouts (D6).

### E12 Chat view audit

The audit script scrolled the whole chat (21 pages, 430 distinct lines).

- **No leaks.** No `[code-foundry wake]`, no seed text, no wake JSON and no
  `cf-task://` text appeared in the visible chat. The JSON on screen is Ember's own
  content (README examples). The seed prefix is not shown: it is in
  `UserMessageItem.seedPrefix`, and the GUI leaves it unmapped.
- **Fold rows.** They are accurate and well summarised: "Worked for 9s · created 1
  thread, updated the board, used 1 skill", "Worked for 8s · 1 wake, updated the board,
  checked git", "Worked for 1m · read 1 file, created 1 thread, updated the board, ran 1
  command" (the `find /` turn), "Worked for 1s · noted 1 fact".
  - Show work opens the run: the Skill row, the three `code-foundry` commands with ok and
    durations, the "Woken by Add --version flag to tally: idle, finished …" row and the
    git check.
  - Thinking-only turns show a bare "Worked" with no time or summary: E9, the first turn
    of epoch 3, and three of the lead progress wakes ("Worked · 1 wake"; G6).
- **Task links.** They resolve and stay live: "tally: add --version flag with test ·
  done", "· done · 4 pieces", "· in progress".
- **Path chips.** They are broken in Ember's chat. Clicking `README.md` opened the File
  tab on "Cannot read the file: /tmp/ember-exp-home/residents/ember/README.md is outside
  your home directory". A git range `origin/main...cf/combine-tally-flag-branches` also
  rendered as a file chip (G1).
- **Pinned row.** The sampler log over the round:
  - thinking while Ember's turn ran, working while only workers ran, attention
    (Finished) after a reply the user had not seen;
  - intermediate wake replies while workers still ran did not flip to attention (the
    "waiting on N children" status wins);
  - when Ember asks a question the row says "Finished", not something like "Needs
    input" (G5);
  - with a worker waiting on the user's answer (E14), the row's attention came only from
    Ember's unseen relay. Once the chat was opened it went back to "Working" with the
    working flame while the worker still waited; the board said "Needs input" (G2).
- **Board.** Sections and cards are right. A blocked outcome is drawn in full: 10 amber
  lines for the npm error (G4). A lead's team does not show (G3).
- **Themes.** Light and dark both look right.

### E13 Timer (added)

"A teammate is about to push a fix to tally's main. Check origin/main of tally again in 2
minutes and tell me what landed." (07:04:39)

- Ember did not know timers existed (neither skill nor rules mention them). It found
  `thread subscribe --at 2m` through three `--help` calls (17.2 s, $0.067).
- Its reply said "at 12:06 UTC", although the user is in CDT.
- I pushed a README commit to main at 07:05. The wake "Timer sub-d1e35e086d1a fired at
  07:07 CDT (set for 07:06 CDT)" came within the 10 s check.
- Ember reported the exact commit, noted it was a README line and not a code fix, and
  that `cf/document-format-in-tally-readme` may conflict (10.0 s, $0.042).

### E14 A worker's question (added)

"In notes-api, add PUT /notes/:id … have the worker ask me that question [404 or create]
itself before it writes the handler." (07:26:49)

- The worker asked with AskUserQuestion at 07:27:19 and the wake carried the pending
  question.
- Ember (5.1 s) relayed the two options without answering, but sent the user elsewhere:
  "The PUT worker is now waiting for your answer in its own thread, "Add PUT /notes/:id
  to notes-api"". That thread is a hidden child; the user only reaches it through the
  Board.
- When the user answered "404." in Ember's chat (07:34:29), Ember found `thread respond`
  through `code-foundry commands` and `help thread.respond`, then answered the request
  (13.6 s).
- The worker finished at 07:35:12. Ember verified and closed the task with "It needs
  Dana's review": the E5 memory, applied.

### E15 Two quick messages (added)

At 07:25:14, "Go ahead straight to main for that README line" was sent without `--wait`,
and 3 s later "And in tally, add a -w flag …". Both went into one turn (19.7 s, $0.103):
two tasks, two workers and one reply with both links. Both wakes later batched into one
turn.

### E16 "Just do it yourself" (added)

"Quick one, just do it yourself, no worker needed: … commit it to main." Ember refused
(3.9 s): "I can't make this one myself. I don't edit files or commit in my own session".
It also pushed back with "this is a notes-api change, so it needs Dana's review, and
committing straight to `main` would skip that", and asked. Nothing was written: `git
status` was clean. The pushback cost the user a round trip after an explicit instruction,
but it applied a remembered convention; judgement, not a bug.

### E17 Merge, then clean up (added)

I merged `cf/combine-tally-flag-branches` into tally main and pushed. Then: "I merged … Clean
up whatever is finished in tally." (07:26:23 → 07:26:41, $0.080)

- Ember checked `git merge-base --is-ancestor` on origin.
- It archived the five tally threads whose work is on main and ran `project worktree
  cleanup <tally> --yes`, which removed 6 worktrees (the cancelled `--top` one included).
- It kept the unmerged `-w` thread and worktree and did not touch remote branches ("you
  said to leave them"). All correct.
- It also wrote a progress note with `ember remember`: "tally main now includes … Merged
  tally threads archived, worktrees cleaned …". That is board progress in the memory's
  Notes, with the doubled date again (D4, S6).

### Verification quality (across experiments)

Ember checked each done report against origin before `ember task done`. It ran
`git log origin/main..origin/<branch>`, `git diff --stat` and `merge-base`, and
separated what it verified from what workers claimed. It caught three things a worker
glossed over:

- a non-compiling middle commit on the combined branch: "commit `021e29e` doesn't
  compile … the next commit, `f95302f`, fixes it … that commit will break a bisect";
- the untracked `package-lock.json`;
- conflicts between sibling branches in `listNotes.ts` and `format.go`, before anyone
  merged.

## Findings

Severity: **blocks** (blocks real use), **annoying**, **polish**. Ranked within each part
by how much it costs a real user.

### Daemon and CLI

**D1. A lead's progress settles wake Ember while its team still works (annoying).**

- Evidence: E7. 5 of the lead's 6 wakes were noise (#83, #86, #89, #92, #95), each an
  Opus turn and a visible "still running" reply. The log shows one `wake held` in the
  whole run.
- Cause:
  - `heldLeadWake` (`internal/store/thread/subscriptions_batch.go:247`) holds only with a
    fresh progress report (`!p.d.staleReport`).
  - The lead's first turn (helper only) filed no report, which gave #83.
  - Each later lead turn was set off by a worker's wake and ended in prose after its
    report, so the report was stale ("report is from before its last message"), which
    gave #86, #89, #92 and #95.
- Fix: hold a lead's settle whenever its turn ended plainly and its own children are
  still working, whether or not the report is fresh. The lead's status already says
  "waiting on N child threads" (#245). Wake the parent on the settle after the last
  child settles, or on a pending request.
- Leave alone: the batching itself. Two README wakes 2 s apart were one turn.

**D2. Wake titles say "All 7 of your child threads settled" while a lead's workers run
(annoying).**

- Evidence: #83–#95, while 1–3 of the lead's workers still ran.
- Cause: `siblingsOf` (`subscriptions_batch.go:285-292`) applies its waiting rule
  (`!isTarget && Report == progress && busyKids > 0`) only to non-targets, so the lead
  that fired counts as settled.
- Fix: apply the rule to the target too, or count a target with working children as
  working. Ember ignored the line, but a cheaper model may not.

**D3. Ember costs more than its workers (annoying at the default Opus 4.8 high).**

- Evidence: E11. Ember $2.99 against workers $2.09. A one-piece task costs two Ember turns
  ($0.11–0.21) against a $0.06–0.11 worker. Each turn rereads ~130K tokens across ~3
  calls.
- Cause: three mechanical calls per piece (task add, thread new, task update), each a
  model round trip over the full context. The wake turn adds two more (git check, task
  done).
- Fix: one CLI verb that adds the task, creates the worker (`--labels ember,<id> --notify
  --request-id <id>`) and links it, e.g. `ember task start "<title>" --project …
  --prompt …`. That turns three calls into one and removes the "two separate commands,
  never `$(…)`" footgun the skill warns about. Consider letting `ember task done` take
  the branch and check `origin/<branch>` exists.
- Leave alone: verification before `task done`. It caught real problems (above).

**D4. `ember remember` doubles the date (polish).**

- Evidence: "- 2026-10-20: 2026-10-20: User wants to keep 0.1.0 …" and the same in #247
  (2 of 3 notes).
- Cause: `Store.Remember` (`internal/store/ember/memory.go:21`) prepends the date, and
  Ember writes one too.
- Fix: strip a leading `YYYY-MM-DD:` from the fact.

**D5. Consolidation's spend is invisible (polish).**

- Evidence: two Opus calls of 11–13 s with inputs of 16–23 KB. Neither is in `cf usage`.
- Cause: `claude -p … --no-session-persistence` (`internal/store/ember/consolidate.go:39`)
  leaves no transcript for the usage fold.
- Fix: read the result's usage (`--output-format json`) and record it on the Ember
  status or the usage page. It is small (cents per epoch), but a user who reads the
  usage page should see it.

**D6. Ember runs `git fetch` in the user's project checkouts (polish).**

- Evidence: 17 `cd <project> && git fetch -q origin && …` calls. `git fetch` is not in the
  resident allow list (`git log/diff/show/status`); auto mode let it through.
- Cause: checking `origin/<branch>` needs fresh remote refs, and the project folder is the
  only checkout Ember knows.
- Fix: allow `git fetch:*` explicitly, so the safety classifier is not the gate, or have
  the skill check against the worker's worktree (`git -C <worktree> log
  origin/<branch>`, which the worker's push already updated).
- Leave alone: it only writes remote refs and FETCH_HEAD.

### Skill and prompt

**S1. Leads: Ember cannot find `leads.md` and scans the whole disk for it (blocks real use
of leads).**

- Evidence: E7. A 63 s turn, `find / -path '*code-foundry-orchestrate/reference/leads.md'`,
  and it read `/private/tmp/cf-exp3-restart/…/leads.md`, a stale copy from another
  daemon. On a user's Mac this finds old installs, other homes or dev worktrees first.
- Cause:
  - `internal/skills/files/code-foundry-ember/SKILL.md:74` says "Read the orchestrate
    skill's `reference/leads.md`" with no path.
  - The orchestrate skill is in `<home>/claude/.claude/skills/` (the first add-dir).
    Ember's own skill is in `residents/ember/skills/`, so the guess fails.
  - Ember never loaded code-foundry-orchestrate with the Skill tool, in any of three
    epochs, although `rules.md:39` says "Read them before your first worker of an
    epoch". The Skill tool would have printed the base directory.
- Fix: give the absolute path in the seed (the store knows the claude dir) or in the
  rules, or tell Ember to load code-foundry-orchestrate with the Skill tool before
  starting a lead. Also forbid `find /`.

**S2. The ember skill leaves out verbs Ember needs (annoying).**

- Evidence: 9 discovery calls in E4, E13 and E14.
  - Steering: `thread --help`, then `thread send --id <worker>`.
  - Timers: `--help` three times, then `thread subscribe --at 2m`.
  - A worker's question: `commands | grep`, `help thread.respond`, then `thread respond
    --request --answer`.
- Cause: Ember never loads the orchestrate skill (S1), so the ember skill is its whole
  manual, and it names none of these.
- Fix: a "Steering and answering" paragraph in the ember SKILL.md:
  - a change for a working worker is `thread send --id <worker>` plus `thread rename
    --id <worker> --name …` and the task's title (parent included, E4);
  - a worker's pending question or permission is relayed in Ember's chat with its
    options, and the user's answer goes back with `thread respond --id <worker>
    --request <id> --answer "…"`;
  - "later" is `thread subscribe --at <duration>`.

**S3. Ember sends the user to a hidden worker thread to answer it (annoying).**

- Evidence: E14: "waiting for your answer in its own thread". The user cannot see that
  thread in the sidebar.
- Fix: covered by S2's paragraph: Ember is the user's one place to answer. Never point
  the user at a worker thread.

**S4. Replies are longer than the rules ask, with boilerplate (polish).**

- Evidence (E11):
  - average 676 characters;
  - bold-labelled bullet lists on partial-batch wakes (#37, #47);
  - "It starts from main, so it doesn't include the unmerged …" on 5 start replies;
  - "I didn't run the tests myself" 9 times;
  - mid-turn narration as separate paragraphs ("Still early; I'll redirect it.").
- Fix in `files/rules.md` "How you talk":
  - mention a branch's base only when the piece depends on unmerged work;
  - say once per request (not per reply) that tests are the worker's claim;
  - write nothing between tool calls; the reply is the turn's last text.
- Leave alone: the honesty (claimed vs verified) and the final summaries. E7's and E5's
  were the best output of the round.

**S5. Memory drifts into a progress log (polish).**

- Evidence:
  - MEMORY.md grew a "Pushed branches" section with shas and per-branch details in both
    consolidations;
  - Ember used `ember remember` for progress (#247: "Merged tally threads archived,
    worktrees cleaned"). 3.3 KB is fine today; the trend is a log.
- Cause: `files/consolidate.md` says to drop progress already on the board, but the
  model keeps it. The skill does not say what `remember` is not for.
- Fix:
  - consolidate.md: "no branch lists, no shas; the board has them";
  - SKILL.md: "remember preferences, conventions, people and decisions, never progress".
- Leave alone: open follow-ups with task ids. E5's answer leaned on them.

**S6. Times are given in UTC (polish).**

- Evidence: E13: "at 12:06 UTC". The wake header says "07:07 CDT".
- Fix: put the local time zone in the seed (BOARD.md already has "As of … 06:50" in
  local time without a zone).

### GUI

**G1. Path chips in Ember's chat open files under Ember's own directory (annoying).**

- Evidence: E12: "Cannot read the file … /tmp/ember-exp-home/residents/ember/README.md is
  outside your home directory". In a real home it would be "not found". A git range
  became a chip too.
- Cause: `PathChip`'s `usePathPlace` (`gui/frontend/src/components/thread/PathChip.tsx:13`)
  falls back to `{project: thread.projectId, base: cwd}`. For Ember that is `""` and
  `residents/ember`, and Ember's paths are relative to whichever project it is talking
  about.
- Fix: provide a `PathPlaceContext` in `EmberBody` that turns chips off (plain code). Or
  have Ember write absolute paths and resolve those only.

**G2. A worker waiting on the user does not reach the Ember row or the bell (annoying).**

- Evidence: E14. The PUT worker's question was pending from 07:27:19 to 07:34:43. Until
  the chat was opened, the row's attention came only from Ember's unseen relay. After
  that it read "Working · notes-api: add PUT /notes/:id …" with the working flame. The
  Board card said "Needs input" the whole time. A user who glanced at the chat without
  answering would lose the signal.
- Cause: `emberStatusWords` (`gui/frontend/src/lib/ember.ts:238`) looks at Ember's own
  thread, then any doing task, as Working. Workers' prompts are hidden children, which
  the bell leaves out.
- Fix: when a doing task's worker has a pending prompt or question, the row says "Needs
  input" (amber) with the attention flame, and the bell counts it once (Ember's row).

**G3. A lead's team is invisible (annoying).**

- Evidence: E7. The card showed only "Lead: notes-api input validation · Idle" while its
  six workers ran. The header said "Nothing in progress" and the row's "· 1 thread"
  flickered with the lead's own busy state.
- Cause: the board's thread view (`EmberTaskThread`) is the task's one thread.
  `workingThreads` and `workerRows` (`lib/ember.ts:218`, `:188`) count only it.
- Fix:
  - give `EmberTaskThread` its descendants' counts, or a short list (the daemon has
    `--descendants-of`);
  - count those as working in the header and the row;
  - draw them as worker rows under a lead;
  - show a lead's "waiting on N" as working, not Idle.

**G4. A blocked outcome is drawn in full (polish).** Evidence: 10 amber lines for E3's
npm error at the top of In progress. Cause: `BoardSurface.tsx:106` renders the outcome
unclamped. Fix: clamp it to 2–3 lines, with the full text on hover or on click.

**G5. "Finished" after a reply that asks the user something (polish).**

- Evidence: E1, E3, E9, E14 all ended in a question. The row read "Finished" with the
  attention flame.
- Fix: maybe nothing. The attention flame is right, and the words would need the daemon
  to know the reply is a question. If cheap, have Ember's turn mark it (e.g. the reply
  ends with "?").

**G6. Thinking-only runs show a bare "Worked" (polish).**

- Evidence: E9's row, the first turn of epoch 3, and "Worked · 1 wake" on the lead
  progress wakes.
- Cause: `workMs` (`lib/ember.ts:471`) sums tool segments, so a run with no tools has
  0 ms, and `workSummary` has nothing to list.
- Fix: use the turn end's `durationMs` for the time, or draw no work row for a run with
  only thinking and a wake.

### What I would leave alone

- The request → task → worker → wake → verify → done loop, and the verification before
  `task done`.
- Splitting with a parent task, `--base origin/<branch>` for dependent pieces, and one
  task link per piece.
- Blocked handling (the daemon's auto-block, said once, no retry) and cancel (interrupt,
  cancelled, archive, honest about the worktree).
- Epochs:
  - the boundary at idle;
  - the consolidation and seed shapes;
  - RECENT.md as the source of "what did I just say";
  - E5's and E6's answers were right after a fresh session.
- Restart recovery: the restart wake and Ember's resume message.
- The fold's summaries, Show work, the live task links, the board's sections, and the
  absence of any wake, seed or JSON in the chat.
- Ember refusing to edit files (E16). The deny list was never needed: Ember never tried.

## Suggested build order

1. **S1 + S2 + S3**, one skill PR: `leads.md` path or Skill-tool load, no `find /`, plus
   the steering / answering / timers paragraph. Cheapest, and it removes the 63 s lead
   turn and the hidden-thread answer.
2. **D1 + D2**, one daemon PR: hold a lead's settles while its children work; sibling
   counts for a target lead.
3. **G2 + G3**: worker prompts on the row and bell; a lead's team on the board, header
   and row. G3 needs a small proto addition (descendant counts on `EmberTaskThread`).
4. **D3**: `ember task start` (CLI + skill), then measure the per-task Ember cost again.
5. **G1**, then the polish items (D4, D5, D6, S4–S6, G4–G6) as one or two small PRs.

## Cleanup

The daemon was stopped (SIGTERM), and the Vite server and sampler were killed. These were
deleted: `/tmp/ember-exp-home`, `/tmp/ember-exp-tools`, `/tmp/ember-exp-shots`,
`~/scratch-ember-exp` and the matching `~/.claude/projects/*ember-exp*` transcript
folders. `/private/tmp/cf-exp3*` (round 3's homes, which S1 found) are not this round's
and were left in place.
