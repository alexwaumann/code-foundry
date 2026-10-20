# Wake detail: a wake per pending request, and what a settled wake says (2026-10-19)

Follow-up to `agents-4-wake.md` from the Haiku 5.5 orchestration experiment of
2026-10-18 (`/tmp/cf-exp/results/REPORT.md`, findings C2-C6; e2 finding 1, w2a findings
1-2 and 4, w2d 1-2, e5 5, w3c 2). Three holes in thread wakes:

* **C2, no wake for the next prompt.** `observeLocked` fired only on the edge into the
  condition. A supervised child answered on `permission: Edit` and asking `permission:
  Bash` within the 100 ms status debounce publishes one change, from one prompt to the
  next, and never leaves needs attention: no wake, and in W2A the parent stalled 7
  minutes.
* **C3/C4, a prose question looks like done; a prompt carries nothing to act on.** The
  wake said `is idle: finished`, `report: null`, with neither the child's last words nor
  the pending request's id, input or option labels.
* **C5/C6, stale reports and premature lead wakes.** After a follow-up the wake quoted
  the old report as current; a lead ending its turn with workers running woke the top
  with a bare "finished".

## Decisions

* **A settled or attention subscription also fires on each new pending request while
  the condition holds.** The key is the new `Thread.PendingRequestID` (not persisted):
  the request the `permission: …`/`question: …` reason describes, published with the
  status (`streamStatus.asking`; the runner's debounce now also compares it). Two
  prompts in a row can read alike (`permission: Edit README.md` twice); the id tells
  them apart. Without an id (a row set by hand) the reason is the key. A stopped
  thread has no key: it keeps the reason of a request that ended with its process, and
  that must not wake anyone. Idle, error and disconnected subscriptions are unchanged;
  a one-shot is gone after its first fire, so it behaves as before. A reason change
  that is not a new request (finished, then budget reached) does not fire.
* **The wake is built when it is sent, not when it fires.** `fireLocked` runs under
  `m.mu`, and a thread's items sit behind `m.tmu`, which must not be taken inside
  `m.mu`. A thread wake now captures the thread as published and its children counted
  at the fire, and `drain` reads the target's items (`Manager.Items`) just before
  `Send` (`fireThreadLocked`, `wakeDetailOf`). Run, pull request and plugin wakes are
  built at the fire as before (`fireLocked` wraps them).
* **Report staleness**: a report is stale when filed before the thread's last user
  message (any origin: a follow-up or a wake to a lead). When the turn has ended
  (`Meets(idle)`) and there is no report or a stale one, the JSON has `report_stale:
  true` and `last_message`: the ended turn's last assistant text (the thread's own,
  not a subagent's), one line, cut at 500 runes; "" when that turn said nothing. A
  stale report is still in `report` but no longer quoted in the header.
* **`pending`** (`kind` permission|question, `request_id`, `tool`, `input`, and for a
  question `question` + `options` labels, `questions` when it asks several): the item
  of `PendingRequestID`, else the oldest pending one that reads as the reason. `input`
  is the tool's JSON up to 4 KiB, else its head as a string with a "`thread read
  --full` has it all" marker.
* **`children`** (`working`, `reported`, `total`): threads whose `created_by` is the
  target, not archived; working = not settled, shown waiting, or with working children
  of its own (ember-fixes-1-wakes.md), reported = has a report. Omitted when
  there are none; the header adds `; 2 of its 3 child threads still working` (or `; its
  child thread is still working`) when any work.
* **Header**: settled and idle wakes take the verb from the status (`needs attention`
  for needs_attention, `has an error`, else `is idle`), never "is idle: finished".
  `finished without a report`, `<reason> (no report)` for other ended turns, `(report is
  from before its last message)`. Name, reason and summary are cut to 80, 120 and 120
  runes so the line stays near 300 characters; the JSON has everything. The GUI's
  "Woken by" row shows the title as is.
* **Item 3 of the brief, `thread read` truncation**: `thread read --full` already prints
  whole texts and inputs; the skill now points there, and `last_message` makes the
  read unnecessary for a short prose question. No code change.
* **Guide**: not touched. `internal/guide` is a few bytes under its 29,000-byte cap
  (`TestGuide`); the wake fields are described in the orchestrate skill's "Wait; do not
  poll" step (and `patterns.md`'s no-report line) instead.

Left out (other PRs or later): `thread respond` printing what is still pending (w2a
finding 2), the supervised-mode help wording (w2a finding 4: "confirm every tool call",
but read-only tools run unconfirmed), keeping report history (C5's second half), a
`reported` condition, burst coalescing (C7).

## Gotchas

* The C2 fix only matters when the next prompt lands within the status debounce of the
  answer. In the e2e a Write answered at .648 and a Bash asked at .747 published as one
  change (fired at .749); two parallel Bash calls did not (the first ran for 460 ms
  first, so the status passed through busy and the old edge fired too).
* `wakeDetailOf` compares the report time with the last user message truncated to the
  millisecond: reports are stored at millisecond precision, items are not.
* The worktree-isolation hook refuses command lines with prompts that read like shell;
  the e2e ran from small scripts under `/tmp/wd-scripts` calling a `cf` wrapper (the
  branch binary with `CODE_FOUNDRY_HOME=/tmp/wd-home`).

## End to end (2026-10-19, isolated home, Haiku 5.5 medium)

`make build`; daemon `CODE_FOUNDRY_HOME=/tmp/wd-home code-foundry daemon --dev` with the
branch's `bin` first on PATH; `threads.default_model 'claude-haiku-5-5[1m]'`,
`threads.default_effort medium`; scratch project `~/cf-exp-scratch/wd-todo` (a clone
of a bare `wd-origin.git` made from `todo-template`). A parent thread `wd parent`
(s-19841a04d375) told to reply "noted" to every wake; children made with
`--created-by s-19841a04d375 --notify`. Wake text as the parent received it.

**(a) A prose question, no report, then a stale report.**

```
$ cf thread new --project wd-todo --name "wd prose question" --created-by s-19841a04d375 --notify \
    --prompt "Do not use any tools. Ask me, in plain text in your reply (not with a question tool), whether the todo export should write JSON or CSV, and recommend one. Then end your turn and wait for my answer. Do not file any report."
[code-foundry wake] Thread "wd prose question" (s-590245866df4) needs attention: finished without a report.
  …"report": null,
    "report_stale": true,
    "last_message": "Should the todo export write JSON or CSV? I'd recommend JSON. Todo items usually carry nested or variable fields (tags, due dates, subtasks, notes), which JSON keeps intact and round-trips cleanly. CSV is flatter and friendlier for spreadsheets, but it needs a convention for multi-value fields and loses structure. If the export is mainly for opening in Excel or Sheets, CSV is the better pick. Which format do you want?"
$ cf thread read s-590245866df4            # the plain view cuts it; --full has it
#3 claude: Should the todo export write JSON or CSV? …
$ cf thread send --id s-590245866df4 --wait "JSON. … run: code-foundry thread report done --summary 'Chose JSON for the export'"
[code-foundry wake] Thread "wd prose question" (s-590245866df4) needs attention: finished. Report: done — Chose JSON for the export.
$ cf thread send --id s-590245866df4 --wait "Now, without any tools, ask me in plain text whether the export file should be called todos.json or export.json, then end your turn."
[code-foundry wake] Thread "wd prose question" (s-590245866df4) needs attention: finished (report is from before its last message).
  …"report": { "status": "done", "summary": "Chose JSON for the export", "data": null, "at": "2026-10-19T06:02:08.209Z" },
    "report_stale": true,
    "last_message": "Should the export file be called `todos.json` or `export.json`?"
```

**(b) A supervised child with two tool calls back to back** (`--permission supervised`;
a script answered each prompt with `thread respond --decision allow` as soon as it
showed):

```
$ cf thread new --project wd-todo --name "wd supervised 2" --created-by s-19841a04d375 --notify --permission supervised \
    --prompt "In ONE message, make two tool calls in parallel: the Write tool creating wd-c.txt with the content c, and the Bash tool running 'touch wd-d.txt'. Then reply done. Do not file a report."
daemon.log:
01:03:02.284 claude asks tool=Write request=80ba9512-…
01:03:02.386 wake subscription fired … condition=settled fired_count=1
             (Write answered at .648: item #5 updatedAt)
01:03:02.747 claude asks tool=Bash request=f6814217-…
01:03:02.749 wake subscription fired … condition=settled fired_count=2   <- the debounce published Write -> Bash as one change
01:03:05.009 wake subscription fired … condition=settled fired_count=3
parent:
#23 wake: Thread "wd supervised 2" (s-98b487e7eef1) needs attention: permission: Write wd-c.txt.
#24 wake: Thread "wd supervised 2" (s-98b487e7eef1) needs attention: permission: Bash Create empty file wd-d.txt.
#29 wake: Thread "wd supervised 2" (s-98b487e7eef1) needs attention: finished without a report.
```

The first run (two parallel Bash calls, `wd supervised`) also woke twice, with the
request detail:

```
[code-foundry wake] Thread "wd supervised" (s-e75990a152cd) needs attention: permission: Bash Create file wd-a.txt.
  …"pending": { "kind": "permission", "request_id": "fef9f72b-3e51-4f81-bb2f-2560cbafdc8f", "tool": "Bash",
                "input": { "command": "touch wd-a.txt", "description": "Create file wd-a.txt" } }
[code-foundry wake] Thread "wd supervised" (s-e75990a152cd) needs attention: permission: Bash Create file wd-b.txt.
  …"pending": { …"request_id": "6c1b89c4-240c-481e-add4-b01f3d8c88b6", … "command": "touch wd-b.txt" … }
```

A question through AskUserQuestion carries its labels, and `--answer Tabs` took one:

```
[code-foundry wake] Thread "wd question tool" (s-15583445bcdf) needs attention: question: Which indentation should .editorconfig use?
  …"pending": { "kind": "question", "request_id": "75953abe-…", "tool": "AskUserQuestion", "input": { "questions": [ … ] },
                "question": "Which indentation should .editorconfig use?", "options": [ "Tabs", "Spaces" ] }
$ cf thread respond --id s-15583445bcdf --answer Tabs
Which indentation should .editorconfig use?: allowed (allow): Which indentation should .editorconfig use? = Tabs
```

**(c) A lead ending its turn with workers running.** The lead (`--created-by` the
parent, `--notify`) ran two `code-foundry thread new … --notify` and replied "started":

```
[code-foundry wake] Thread "wd lead" (s-f000547bcf6b) needs attention: finished without a report; 2 of its 2 child threads still working.
  …"report_stale": true,
    "last_message": "started",
    "children": { "working": 2, "reported": 0, "total": 2 }
[code-foundry wake] Thread "wd lead" (s-f000547bcf6b) needs attention: finished without a report; 1 of its 2 child threads still working.
[code-foundry wake] Thread "wd lead" (s-f000547bcf6b) needs attention: finished without a report.
```

(The lead's later wakes are its turns on each worker's wake. Worker 1's `sleep 60` was
blocked by Claude Code's harness, so it finished early; it was busy when the lead
settled.) The daemon log had no ERROR lines. The daemon was stopped afterwards.

## Daemon restart

Needed: the commit hook and the wake payloads are daemon code. The GUI is unchanged
(it shows `WakeTitle` and `WakeJSON` as they come).
