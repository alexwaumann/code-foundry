# Search 5: Agent search, the daemon side

Status: PR 5 of 6 in the thread search series, on branch `cf/search-5-agent-daemon`. Daemon,
proto and CLI only; PR 6 builds the dialog and the mock. Needs a daemon restart (migration
0055, a new service).

The user asks a question in their own words ("where did we decide the PR poller shouldn't
refetch on CI reruns?"). A hidden one-shot Claude run searches their threads and reports
the messages that answer it, each verified by a quote, then a short answer.

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/search.proto` | `SearchService`: StartAgent, Watch, WatchRecent, Stop, ListRecent, Get, OpenHit, MarkSeen, RecordFind, Forget, Clear, Promote, Report |
| `internal/store/search/` | the store: history (`db.go`), the run (`run.go`), steps from tool calls (`steps.go`), the system prompt, wrap-up and promote messages, citation links (`prompt.go`) |
| `internal/db/migrations/0055_search_history.sql` | `search_history`: one row per entry, hits and steps as JSON arrays |
| `internal/store/thread/search_quote.go` | `Manager.VerifyQuote`: a reported hit's checks |
| `internal/store/thread/{thread,manager,claude,memory}.go` | `CreateOptions.ResumeSession` (Promote): `--resume <id> --fork-session`, the system prompt rendered fresh |
| `internal/api/search.go` | the handler: Watch's versions, gap resync, WatchRecent |
| `internal/command/commands_search.go` | `search.*` (below); `cmd/code-foundry/search.go` streams `search agent` |
| `internal/daemon/stores.go`, `daemon.go`, `internal/paths` | wiring; `<home>/search/{cwd,tmp/<id>}` |

## Decisions

* **The run is not a thread.** The store starts claude itself over stream-json
  (`claudestream`), so it never reaches the thread snapshot: no sidebar, lists, Watch,
  dock alerts (the GUI derives those from threads), wakes, index or `Unindexed` hook. The
  "decide Unindexed from something persisted" gotcha of search-3 does not arise. Reusing
  the thread machinery would have meant filtering a hidden thread out of every one of those.
* **Usage: like naming, the run is not in Usage.** Its cost (the result's
  `total_cost_usd`) is on its history entry. Once promoted, the thread's transcript is a
  fork that starts with the search's records, and the thread's usage fold counts them (no
  `notBefore`, unlike a fork of a thread): the search's cost then shows in Usage once, under
  the thread that took it over. A run cut off before its first result (stopped, timed out)
  records cost 0.
* **Tools, on flags a managed laptop allows** (`runArgs`):
  `-p` stream-json, `--session-id`, `--model <models.utility> --effort low`,
  `--tools Bash`, `--permission-mode dontAsk`, `--safe-mode`,
  `--system-prompt-snapshot off`, `--append-system-prompt <prompt>`, and
  `--allowedTools "Bash(code-foundry thread search *)" "Bash(code-foundry thread read *)" "Bash(code-foundry search report *)"`.
  No hooks, no `--strict-mcp-config`, no `--mcp-config`, no `--settings`. Checked with
  Claude Code 2.1.316: those three verbs run; `code-foundry thread list`, `cat ~/.zshrc`,
  `ls /` and `a && cat /etc/hosts` are denied without a prompt. **dontAsk still runs
  read-only commands inside the working directory** (`ls`, `cat f.txt`, `echo`), so the run
  starts in `<home>/search/cwd`, an empty directory; that is why it does not run in
  `$HOME`. When claude refuses a flag (`thread.IsFlagRefused`: an older Claude, an
  organization's settings) the run is retried once without `--safe-mode` and
  `--system-prompt-snapshot`, and later runs in this daemon start that way; the tool
  limits stay.
* **The run's cwd and Promote.** Claude finds a session by id in any project dir, so the
  promoted thread (cwd `$HOME`) resumes a session written under `<home>/search/cwd`
  (verified on 2.1.316 by hand and end to end). `Create` checks the transcript with the
  store's glob fallback. It forks (`--resume <sid> --fork-session --session-id <new>`):
  the thread has its own transcript in `$HOME`'s project dir, so forgetting the search
  (which deletes the search's transcript) leaves the thread working; checked across a
  daemon restart.
* **System prompt snapshot.** With the default snapshot on, a resumed or forked session
  reuses the first request's system prompt even when a later launch passes another one
  (checked: a fork kept a "say BANANA" append). The run passes
  `--system-prompt-snapshot off`, so the promoted thread renders its own prompt (app
  memory, skills, its append), and the search's instructions do not follow it.
  `launch.freshPrompt` makes the memory count as in the prompt (no refresh note).
* **The question is the first user message**, the instructions the appended system prompt
  (written in Go, `systemPrompt`). The promoted thread is named from the question by the
  normal namer (it reads the transcript's first user text): "PR poller CI rerun refetch
  decision".
* **Caps.** 2 minutes in all (`WallTime`); at 95 s, or at the 24th tool call, the turn is
  interrupted and a wrap-up message asks for the answer from the reports made. At 2
  minutes the process is killed: DONE with "stopped at the 2m0s limit" when it has a hit,
  else FAILED. 8 hits (`MaxHits`): a 9th report is refused with "write your answer now";
  the 8th's answer says it was the last. Reaching the hit cap does not interrupt (the
  model is told to answer; interrupting would cut a good answer off).
* **Stop** (GUI Esc, `search.stop`, ^C in `search agent`) kills the process group
  (SIGTERM, SIGKILL after 2 s): STOPPED with the hits it has. The run keeps going with no
  client watching. Daemon shutdown ends running searches FAILED ("the daemon stopped while
  it ran"), and a RUNNING row found at start is ended the same way.
* **The answer is the final message** (the result's text, else the last assistant text),
  not a command: one fewer call, and the prompt asks for 1 to 3 sentences citing reports
  as [n].
* **Hits accept `--item` as `#N` or an item id.** `thread search` and `thread read` print
  ordinals, so the model reports what it sees; the daemon resolves it.
* **Verification** (`VerifyQuote`): the thread is in the default search scope (the
  user's threads: not a hidden child, not a plugin's, not `Unindexed`); the item is the
  thread's own (not a subagent's) indexed message with text (not a tool call, wake or API
  error); the quote (trimmed, white space runs one space, quote marks and `…`/`...` around
  it dropped) occurs in `itemSearchText`, as is or with markdown markers `* _ \` # >` and link
  targets left out of both sides (a model quoting rendered markdown). Case is exact.
  At least 12 characters unless it is the whole message, at most 600. Duplicates are by
  item id (a fork's copy is the same message). Each refusal names the problem, and a
  missing quote shows the message's first 200 characters, so the model can fix the call.
* **History.** 50 entries across both modes; the oldest go when a new one is added (a
  running search is never dropped). Forgetting an agent entry stops it first and deletes
  `projects/*/<session>.jsonl`, `projects/*/<session>/` under Claude's dir, and
  `<home>/search/tmp/<id>`. A Find entry with the same query is replaced (moves to the
  top). Hits whose thread was removed are dropped when an entry is read (stored hits stay;
  an archived thread's stay, marked archived). Thread names in hits are the current ones.
* **Commands** (category Search, left out of the agent guide like dictation.*):
  `search.agent <question>` (waits for the end; the CLI streams), `search.stop`,
  `search.recent`, `search.get`, `search.open-hit <id> --hit N`, `search.seen`,
  `search.find <query>`, `search.forget`, `search.clear` (confirm; the only one in the
  palette), `search.promote`, `search.report` (the run's). NoPalette for the rest (a
  question or an opaque id). `search.recent` and `search.get` are read-only.
* Step texts say `#a–#b` for a read (the ordinals it printed), not "turns": they are the
  same numbers the hits and `thread read` use.

## For PR 6: API and events

Entry (`SearchEntry`): `id`, `mode` (AGENT/FIND), `query`, `created_at`; for agent:
`finished_at`, `status` (RUNNING/DONE/FAILED/STOPPED), `error` (why it failed or how it
ended), `answer`, `hits[]`, `steps[]`, `searches`, `threads_read`, `claude_session_id`,
`model`, `cost_usd`, `duration_ms`, `unseen`, `version`, `promoted_thread_id`.

Hit (`AgentSearchHit`): `n` (1 up, report order; the answer cites `[n]`), `thread_id`,
`thread_name` (now), `archived`, `item_id`, `ordinal`, `speaker`, `item_created_at`,
`quote`, `why`, `opened`, `reported_at`. The quote is the model's, one line: it occurs in
the item's search text as is or in markdown-stripped form, so to highlight it in the item,
match it the same way (`locateQuote` ignores white space already).

Step (`AgentSearchStep`): `index`, `kind` (SEARCH/READ/OTHER), `done`, `failed`, `text`
(ready to show), and `query`/`hits`, `thread_id`/`thread_name`/`from_ordinal`/`to_ordinal`.
Texts: `Searching poller refetch…` → `Searched poller refetch · 2 hits` (`· no hits`,
`· 1 hit`, `· failed`); `Reading <name>…` → `Read <name> · #1–#3` (`· #7`, or no range);
other calls: their description, `…` while running, `· failed`. A report makes no step. The
current step is the last one not done; none while the model thinks.

`Watch(id)` order: one `snapshot` (version V), then events with versions V+1, V+2, …:
`step` (an upsert by `index`: sent when the call starts and again when its result comes),
`hit` (a new `n`), `answer` (once), `status` (last: status, error, finished_at, cost_usd,
duration_ms, unseen); the stream ends after `status`. A version gap (an event dropped)
or a change only a snapshot says (opened, seen, promoted) comes as another `snapshot`.
A finished or Find entry: the snapshot alone, then the end. A forgotten entry ends the
stream NOT_FOUND. Heartbeat after 5 s of silence. An example (two searches in one
message, then a read): snapshot(1) → step 0 running(2) → step 1 running(3) → step 0
done(4) → step 1 done(5) → step 2 running(6) → step 2 done(7) → hit 1(8) → hit 2(9) →
answer(10) → status DONE(11). Steps may complete out of order; hits come between steps.

`WatchRecent`: the whole list now, and again after any change to any entry (a burst sends
once); heartbeat. `ListRecent` is the same list. `StartAgent` returns the RUNNING entry.
`Stop` returns the entry once it has ended. `OpenHit(id, n)`, `MarkSeen(id)` return the
entry. `RecordFind(query)` returns the new entry. `Promote(id)` returns `thread_id`
(FAILED_PRECONDITION while running, for a Find entry, or when Claude's transcript is
gone). Errors: INVALID_ARGUMENT (bad question/query), NOT_FOUND (unknown id).

Mock notes: `unseen` turns true at the end and false on MarkSeen or Promote; `version`
grows by one per change, restarting at 1 per entry when the daemon starts.

## Tests

* `internal/store/thread/search_quote_test.go`: the quote table (exact, raw markdown,
  rendered markdown, inline code, white space and line breaks, by ordinal `#N` and bare,
  quote marks and ellipses, a whole short message, too short, wrong words, case, the wrong
  item with the message's start, unknown item, tool call, subagent's, wake, hidden child,
  plugin's thread, unknown thread, empty quote and item, too long); `ResumeSession`
  (argv, refusals, a transcript in another project dir); memory counted fresh.
* `internal/store/search/search_test.go`, over `cmd/fakeclaude` with captures in
  `testdata`: a run's argv, cwd and TMPDIR, its steps, a hit reported while it runs,
  answer, cost, unseen and event order; report refusals (no why, unknown, a Find entry, a
  bad quote, duplicate, the cap); the wrap-up at the tool-call cap (interrupt, then the
  message); ends (API error, stopped, time limit with and without a hit, claude not
  starting); history cap, forget (transcript, session dir and TMPDIR deleted, another
  session's kept), clear, persistence; unseen, opened, removed threads' hits; Promote's
  CreateOptions and message; a leftover RUNNING row.
* `steps_test.go` (shell words, step texts, the citation link's encoding),
  `internal/api/search_test.go` (Watch order, an old and another search's event skipped,
  a gap resynced by snapshot, the end), `internal/command/commands_search_test.go`.

## Verification

* `make check` green.
* End to end in a scratch home (`CODE_FOUNDRY_HOME=/tmp/cfs5-home`, `models.utility` and
  the thread default `claude-sonnet-5-5[1m]`, medium): three real threads without a
  project (a poller decision, a cache TTL question, a release note). `search agent "where
  did we decide the PR poller shouldn't refetch on CI reruns, and why?"` took 10 s and
  $0.02: two searches, one read, two verified hits (the user's message #1 and Claude's #2),
  an answer citing [1][2]. Its transcript showed only the three allowed commands. `thread
  list --all` still had three threads.
* `search promote` made a thread in `$HOME` (named "PR poller CI rerun refetch decision" by
  the namer) whose first message carried the question, both citation links and the
  answer; Claude replied from the search's context. A follow-up asked it, without
  searching, to list the commands it ran during the search (it listed all five exactly)
  and to read `/etc/hosts` with the Read tool (it did: full tools).
* `search stop` on a second, running search ended it STOPPED in 6 s. `search forget`
  deleted the first search's transcript and TMPDIR; the promoted thread answered again,
  and again after a daemon restart (resumed from its own transcript), recalling the
  search's first query. The history (an agent entry and a Find entry) survived the restart.
