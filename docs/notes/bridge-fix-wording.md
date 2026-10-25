# Phase 3, the bridge: last wording and routing fixes (2026-10-25)

The rest of tester A's report after #341–#348: findings 5 (the skill half), 6, 7, 8 and
9, and tester C's leftover 18. Skills and their tests, plus one small thread store fix
(8). No proto, GUI or system prompt change. The tester's numbers are used below.

## What each finding became

- **6, routing misses.** "show me what's running" loaded no skill and listed every
  process on the Mac (other agents' daemons too) and offered to kill them; "make a
  checklist I can tick off" wrote a markdown list of commits.
  - The pages skill's description names the asks: "a checklist or to-do to tick off; to
    see what's running, what's going on or their work (threads, PRs: not the Mac's
    processes)" (396 characters, cap 400). "(merge PRs, …)" became ": merge PRs, …" so
    the purpose `Shipped` reads stays the first clause.
  - The entry skill's description names "what's running, their work" (399, cap 400;
    "asks you to show" became "asks to see", "skills or plugins" "skills, plugins").
  - The entry skill's routing table gets a row: "What's running or going on, their work"
    → "running" here means this app's threads, actions and terminals, never the Mac's
    processes (no `ps`, no killing): `thread list`, `action runs`, `terminal list`; a
    board of it: the pages skill. That is the one sentence the brief asked for. The page
    row names "checklist" and "a to-do to tick off". The entry skill is at its 83-line
    cap.
- **5 (skill half).** The skeleton passes an `onError` that prints the message in the
  page. The example pages do too: the PR list's `cf.on("gh", …, onError)`; the form and
  the Linear page have no `cf.on`. One line each in Live data: `onError(e)` gets a
  refusal (show `e.message` in the page); `cf.off(source)` (or the function `cf.on`
  returns) stops it. `pages_test.go` counts the top-level arguments of every
  `cf.on("…", (…` in SKILL.md and examples.md, and fails under three.
- **7, rows that move under the pointer.** SKILL.md has "**Rows stay put** between
  updates": sort by id or keep the user's order, re-sort on a Refresh click or while
  nothing is hovered; a button acts on its row's id from when it was drawn.
  sources.md has the longer version ("Lists with buttons that update live": a stable key,
  `:hover`/`activeElement` checks, the id in the closure, archived and snoozed rows
  leave). The PR example sorts by repository and number.
- **8, "Error · interrupted" while a busy thread is archived.** A store ordering issue,
  not a page problem. `archiveFrom` closed the thread, and the runner's `finish` published
  the cut-off turn as error "interrupted" (`disconnectedStatus`). Then `removeShells` and
  `stopStrays` ran, a few seconds. Only after them did the archive's commit turn it into
  idle "archived" and stamp `ArchivedAt`. Every board saw the interim state.
  - Fix: `markArchiving` sets `record.archiving` before the close (archiveOne, and the
    cascade before its `requestClose`s), unless the thread was interrupted already.
    `detach` (the close's one commit) then applies `archivedStatus`, so the first status
    published is idle "archived".
  - `endArchiving` (deferred in `archiveFrom`) clears the flag. When the archive fails
    and the thread did not start again, it puts error "interrupted" back.
  - `TestArchiveStatus` now subscribes to the bus and fails on any `Updated` with
    "interrupted" during the archive. It fails without the fix (busy, and at a permission
    prompt) and passes with it. A board still sees the thread for those seconds, now
    idle, until `ArchivedAt` lands. A page that removes the row from its own click's
    result (sources.md says so) does not show it at all.
- **9, wording.**
  - "Never try values on the user's real settings to find a limit": the help skill's
    `reference/settings.md` has each setting's range ("9 to 28 pt").
    `settings get --json` has no min or max, so the skill points at the reference.
  - The verbs table is "A starter list: every verb the CLI runs works the same way
    (`memory.add`, `view.open.url`…)". The `view.open.url` row went (it paid for the
    line).
  - `declined`: "the user said no: not an error. Button back, at most a muted "Not
    merged"". The PR example shows "not merged" muted and enables the button again.
  - On success: "in your own words: never print `text`, the CLI's sentence."
  - `request-id` per row: "a second click then resolves with the same thread, a
    success". The form example passes one per line.
  - The form example read `json.thread.name`, but `json` is the thread itself (protojson
    of `Thread`), so it always fell back to the line. It reads `json.name` now.
- **18 (tester C).** The intro: `$CODE_FOUNDRY_PAGES` is "this thread's folder: read
  nothing in other threads' folders or the app's home".

## Paying for the lines

SKILL.md stays at 160 rendered lines (cap 160):

- The bridge's theme and resize sentence became an HTML comment on the skeleton's script
  line.
- The Promise details of `cf.storage` moved to sources.md ("Page storage, in detail").
- The sign-in limit shrank to three lines; its detail moved to sources.md ("Tokens for an
  external API").
- "Data a source lacks" and the gesture paragraph were rewrapped.
- The `view.open.url` row went, and the `declined` and `thread.new` bullets were
  tightened.

The new sources.md sections have multi-word headings above `## thread-list`.
`bridgeSourcesDoc.test.ts` reads only one-word `## <source>` headings, so they are not
taken for sources.

| File | Lines (rendered) | Note |
|---|---|---|
| `code-foundry-pages/SKILL.md` | 160 (cap 160) | description 396 (cap 400) |
| `code-foundry-pages/reference/sources.md` | 182 | 9.6 KB (cap 16 KiB) |
| `code-foundry-pages/reference/examples.md` | 200 | 9.4 KB (cap 16 KiB) |
| `code-foundry/SKILL.md` | 83 (cap 83) | description 399 (cap 400) |
| `code-foundry-help/SKILL.md` | 105 (cap 105) | unchanged |

## Routing check (Haiku 5.5, medium, auto, isolated home)

`make build`, a daemon on `CODE_FOUNDRY_HOME=~/cf-fix-wording` started with CLAUDE* unset,
and a scratch git project (README, `calc.py`, no remote). One fresh thread per prompt,
started 20 s apart. All rows except A3b and A4b ran on b40afcfc (pages description plus
the entry row and "what's running"). A3b and A4b ran on c75dd686, which adds "their work"
to the entry description.

| # | Prompt | Skills loaded | What it did | OK |
|---|---|---|---|---|
| A1 | show me what's running | code-foundry | `thread list`, `action runs`, `terminal list`; "Only this thread is running in Code Foundry right now" | yes |
| A2 | what's going on right now? | code-foundry | git status, then threads, actions, terminals; "two Code Foundry threads in `scratch`…" | yes |
| A3 | what am I working on at the moment? | none | git status and log: a reply about the repository | partly: no process list, no threads |
| A3b | (same, on c75dd686) | none | the same | partly |
| A4 | give me an overview of my work | none | git status, log and branches | partly |
| A4b | (same, on c75dd686) | code-foundry | threads, actions, terminals, then git and PRs: "Nothing is running right now, apart from this thread" | yes |
| A5 | show me what my agents are doing | code-foundry-orchestrate | `thread list`, `thread reports`: "All 10 threads in `scratch` have finished…" | yes |
| B1 | make a checklist I can tick off | code-foundry-pages | `checklist.html` in its pages folder, `cf.storage`, `view.inline` | yes |
| B2 | give me a to-do list I can check things off on | code-foundry-pages | `todo.html`, `cf.storage`, `view.inline` | yes |
| B3 | I want a list of my tasks that I can tick off as I go | code-foundry-pages, code-foundry | `tasks.html`, `cf.storage`, `view.inline` | yes |
| N1 | what does calc.py do? | none | read the file, answered | yes (no pages skill) |
| N2 | add a subtract function to calc.py | none | edited the file | yes (no pages skill) |
| C1 | I want a board of my work | code-foundry-pages | live board: `cf.on("thread-list")` and `cf.on("gh")`, each with an onError that prints in the page; re-render held while hovered; Archive/Merge on `t.id`; declined shown as "Not archived"/"Not merged" | yes |

No thread ran `ps` or listed or offered to kill a process. "What am I working on" in a
project thread still reads as a question about the repository. That is a fair answer,
and it is not the process list. Pushing it to threads would take a system prompt clause,
and this PR adds none.

## Gotchas

- `code-foundry help <verb>` from a shell with `CODE_FOUNDRY_HOME` set auto-starts a
  daemon that inherits that shell's CLAUDE* variables (this session's). Kill it by the
  pid in the home's `daemon.lock`, then start the daemon from a shell with them unset.
- `daemon.restart --yes` restarts into the binary the next client runs (the worktree's
  `bin/code-foundry` here), not `~/.code-foundry/app`.

## Daemon restart

Needed: the skills are written at daemon start, and the archive fix is the daemon's.
