# Phase 3, the bridge, PR 3: the pages skill (2026-10-25)

PR 3 of 3 of the bridge, on top of #341 (daemon, `bridge-1-daemon.md`) and #342 (GUI host,
`bridge-2-gui.md`). The model, asked in plain words, builds a page that uses the bridge
correctly. Skills and help text only, plus two `view.inline` warnings; no proto, GUI or
system prompt change.

## What ships

- **A skill, `code-foundry-pages`** (`internal/skills/files/code-foundry-pages/`),
  model-invocable and in the slash menu like help and plugin. Its description names the
  user's words (page, dashboard, form, chart, tool, checklist, board, tracker, "as UI") and
  the tasks (merge PRs, archive or start threads, change a setting). SKILL.md, in order:
  page vs plugin vs plain reply; before you write it (find the verbs, run each read with
  `--json` to see the shape the page gets, one file, no build step, no framework, `--cf-*`
  variables); the skeleton; the bridge API; the call rules (args by flag name, never `yes`,
  reads any time, everything else from a click or key press before any `await`, several at
  once with `Promise.all` inside the handler, a slider on `change`, the app's own confirm
  dialog, `id: cf.thread.id` for its own thread and leaving it out of lists to act on,
  `sidebar: true` for threads it starts); what to do on each error code; a verbs table;
  live data (`cf.on`, never polling, re-run a verb's read inside a `cf.on` callback, every
  source and the fields a page uses); storage; limits (on screen only, no SSO or OAuth and
  no cookies, so ask for a token; no Code Foundry token); show it and what to say.
- **`reference/examples.md`**: three complete pages: open PRs with Merge and Merge all
  green (`cf.on("gh")`, `pr.merge` with `head-sha`), a form that starts a thread per line
  (all `thread.new` calls in the submit, a draft in `cf.storage`), and a Linear page that
  asks for an API key once (password field, `cf.storage`, `fetch`).
- **Filled from the source**: `{{cf.bridgeAPI}}` is the API block of `bridge.js`'s header,
  verbatim (`internal/skills/pages.go`), and `{{cf.bridgeErrors}}` is `bridge.ErrorCodes`.
- **Routing**: the entry skill's page row now reads "A page, chart, form, board, dashboard
  or tool you make; anything "as a page" or "I can fill in" → the code-foundry-pages skill
  first …, and can read and change the app"; its "Showing things" says the bridge fits the
  card (`cf:resize` stays as the fallback) and points at the new skill. Help's page
  paragraph names it ("one that reads or changes the app: the code-foundry-pages skill").
  Both stay at their caps (83, 105): a rewrap paid for help's line.
- **`view.inline`**: its description adds "with /cf/bridge.js it can call Code Foundry".
  No resize warning for a page that loads `/cf/bridge.js` (the script posts `cf:resize`
  itself; the warning pushed models into hand-written resize code), and a new warning,
  `WarnNoBridge`, for a page that uses `cf.run`/`cf.on`/`cf.ready`/`cf.storage`/`cf.thread`
  without loading the script.
- **Tests** (`internal/skills/pages_test.go`): frontmatter and description words; the API
  lines are the header's; a what-to-do line per error code; every event source named;
  the rules' phrases; the reads it calls reads are read-only; every `cf.run("verb", {…})` in
  the skill and examples names a real verb and real args; the verbs table's verbs and
  backticked args are real and its "(read)"/"(asks …)" marks match `read_only` and
  `requires_confirmation`; the examples never poll or post `cf:resize`. `TestShipped` and
  `TestRender` list the new files.

## ThreadPrompt: no change (0 bytes)

`ThreadPrompt` is 1550 bytes, exactly its cap, before and after. Round 1 of the A/B ran the
branch with the skill and the entry routing only, to measure whether the prompt needed a
clause: all 7 threads loaded `code-foundry-pages` on their own (4 first, 3 after the entry
skill), from the skill's description in Claude Code's skill list. Round 2 (7 more) did
the same. So the smallest clause is none, and every request of every thread stays as it was.
Baseline threads loaded the entry skill in 6 of 7 runs and still never reached the bridge,
which is what the skill's description fixes, not the prompt.

## Sizes

| File | Lines | Bytes |
|---|---|---|
| `code-foundry-pages/SKILL.md` (rendered) | 160 (cap 160) | 9,870 |
| `code-foundry-pages/reference/examples.md` | 181 | 8,235 (cap 16 KiB) |
| description | | 373 characters (cap 400) |
| `code-foundry/SKILL.md` | 83 (cap 83, unchanged) | 6,174 |
| `code-foundry-help/SKILL.md` | 105 (cap 105, unchanged) | 6,743 |
| `ThreadPrompt` | | 1,550 (cap 1550, unchanged) |

## A/B (2026-10-25, isolated homes, Haiku 5.5, medium, auto)

A: main at #342 (`f8e50b55`); B: this branch. Each its own `CODE_FOUNDRY_HOME` under
`$HOME`, CLAUDE* and CODE_FOUNDRY_* unset. The project was a scratch git repository with a
README and `origin` set to the app's GitHub repository, so the `gh` source had a tracked
repository (no open PRs at the time). Every prompt went to a fresh thread
(`thread new --project work --model 'claude-haiku-5-5[1m]' --effort medium --permission auto`).
B round 1 (B1–B7) had the skill and routing; round 2 (C1–C7) added the verbs table; D6 and
D7 reran 6 and 7 after the `pr.checks` row and a classifier failure.

| # | Prompt | A (main) | B (branch) | What went wrong |
|---|---|---|---|---|
| 1 | make me a page that lists my open PRs and lets me merge the green ones | no skill; `gh search prs`, a static page of the result, no merge | B1, C1: `cf.on("gh")`, a Merge per green PR and Merge all green, `pr.merge` with `head-sha` from the click, `declined` handled | none |
| 2 | build me a triage board for my threads where I can archive or snooze each one | entry + orchestrate skills; a page of `code-foundry thread archive --id … --yes` lines to copy | B2: live board (`thread-list`), own thread left out, `{id: t.id}` from the click, but Snooze without `until`; C2: snooze presets (1 hour…next week) and Archive, clicked in the app: both worked | B2 skipped `help thread.snooze` (the classifier blocked it): the verbs table (round 2) names `until` |
| 3 | show me a chart of what my threads have cost that updates live | entry + dataviz; a `threads.json` snapshot fetched by `setInterval`, never fresh | B3, C3: `cf.on("thread-list")` drawing `costUsd`, no polling | none |
| 4 | give me a form where I paste a list of tasks, one per line, and it starts a thread for each | entry + orchestrate; copies `thread new` commands to the clipboard | B4, C4: every `thread.new` started in the submit/click (`Promise.allSettled`), `sidebar: true`, project from `cf.on("project")`, draft in `cf.storage` | none |
| 5 | make me a page with a slider to change the app's font size | entry + help; bridge `settings.set` from an Apply button (the rendering capability), no live value | B5, C5: `cf.on("settings")`, `settings.set` on the slider's `change`, `declined`/errors shown | A worked too |
| 6 | make me a page that watches the checks on PR #342 and tells me when they're all done | entry; `fetch` of GitHub's REST API from the page, unauthenticated, once | B6, D6: `pr.checks` re-run inside `cf.on("gh")`; C6: the PR's rollup from the dashboard lists (it was merged, so in `recentlyMerged`) | C6 less exact: the `pr.checks` row now says how to watch one PR |
| 7 | make me a page that shows my assigned Linear issues | no skill; a `fetch` page with the key in localStorage | B7, C7, D7: password field for a Linear API key, `cf.storage`, `fetch`, issue links via `view.open.url` from a click | B7, C7: `view.inline` blocked by the classifier, so not shown (page fine) |

Every B page linked `/cf/theme.css` and `/cf/bridge.js`, awaited `cf.ready`, used no
`setInterval`, and no B thread wrote `cf:resize` code. The one B page with a broken call
(B2's snooze) was fixed by round 2's verbs table.

**In the app** (`make gui-build`, `gui/bin/Code Foundry` with the B home and binary): C2's
board rendered live with the user's threads; Snooze on C3 snoozed it ("snoozed until
02:19", `thread get`) and its card left the board at once; Archive on C4 archived it
(idle, so no question). The PR page: see "End to end" below.

## Gotchas

- **Auto mode's classifier** returned "no verdict" for Bash in parallel Haiku threads
  (7 started at once: three threads did nothing; staggered 15–25 s apart it still hit
  some calls). The model then skipped `help` checks or could not run `view.inline`. Not
  a skill problem; the verbs table makes the args robust to a skipped `help`.
- **A project that is the app's own repository** contaminates the baseline: the first A
  run used a clone of code-foundry and Haiku read `docs/notes/bridge-*.md` from it. The A/B
  used a scratch repository instead.
- A `python -m http.server` from another session raised a macOS firewall prompt over the
  test window; it was left alone.

## End to end

PENDING

## Daemon restart

Needed: the skills are written at daemon start, and `view.inline`'s warnings are the
daemon's. Threads that exist get the new skill through the skills directory at once.
