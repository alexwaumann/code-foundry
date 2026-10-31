# Removed panels: does asking the model answer what the tabs showed?

Status: run on 2026-10-31 against main after PR #418 (7e9446bb0), with the wording fixes on
branch `cf/removed-panels-skill-fixes`. PR #412 removed the Usage, Linked PRs, Threads, Agents,
Worktree and Workspace side panel tabs (Worktree's lists stayed as the Changes tab; the thread
info card shows the facts). The product rule is "just ask the model", so each question those
tabs answered was asked in plain words in fresh threads, twice, and the transcripts read.

## Setup

* Isolated daemon (`CODE_FOUNDRY_HOME=$HOME/cf-fanout-home`, `make build` of the HEAD above),
  CLI only, no window open (so `view.panel.*` answers "no app window is open": expected).
* Model `claude-sonnet-5-5[1m]` (Sonnet 5.5), effort medium, permission auto, for every thread
  (`threads.default_model` and `default_effort` set; `thread list --json` confirmed each).
* Scratch project `demo` under `$HOME`: five commits; `main` pushed to a local bare remote;
  current branch `feature/shout` tracking `origin/feature/shout`, one commit ahead (two ahead of
  `main`); `greet.py` modified, `TODO.txt` untracked; `.mcp.json` with `echo` (a working stdio
  server, one tool) and `broken` (a command that does not exist). The account's own claude.ai
  connectors also showed up in every thread (one connected, six needing a login).
* Every thread in place (`thread new --project demo --created-by= --focus=false --prompt …`),
  all 16 first-round threads at once on the same checkout. Asks 3 and 4: a setup message, then
  the ask in the same thread (`thread send`). Read with `thread read --last 0 --full`.
* 29 threads in all (asks, extras, re-runs and two child threads): $2.02 at API rates.

## Results, first round (before the fixes)

Time and cost are the asking turn's (from its `turn end` line); tools counts Skill calls too.

| Ask (exact prompt) | Run | Tools | Time | Path | Correct? |
|---|---|---|---|---|---|
| 1 "what changed in this worktree?" | a, b | 1 each | 6.1 s, 5.7 s | `git status --short && git diff && cat TODO.txt` | Partly: uncommitted work only, both runs |
| 2 "which branch am I on and is it pushed?" | a, b, c | 1 each | 4.9, 4.3, 4.4 s | `git status -sb`, `git log @{u}..HEAD` / `git branch -vv` | Yes, all three |
| 3 "which subagents ran in this thread and how did they do?" | a, b | 0 each | 3.1 s, 3.1 s | conversation memory | Yes |
| 4 "show me this thread's lineage: parent, children and their state" | a, b | 1 each | 5.4 s, 5.5 s | `thread get --json` + `thread reports --created-by $CODE_FOUNDRY_THREAD` | Yes |
| 5 "which MCP servers are connected and which failed?" | a, b | 0 each | 3.4 s, 2.8 s | the session's start list | Project servers yes; account connectors stale or mislabelled |
| 6 "how much has this thread cost so far and how many tokens?" | a, b | 1 each | 5.4 s, 5.2 s | `code-foundry usage.show` | Yes |
| 7 "which pull requests are linked to this thread?" | a, b | 5 each | 13.3 s, 14.3 s | guessed verbs, `thread get`, `gh pr list` | "None", hedged; reached by elimination |
| 8 "what projects and checkouts does this thread work in?" | a, b | 1 each | 5.7 s, 5.2 s | `code-foundry thread checkouts` | Yes |

No run invented a fact about this app (no made-up PR, cost, subagent or child). The wrong
parts were omissions (ask 1) and stale state (ask 5).

### 1. What changed

Both runs ran git directly (no skill loaded) and reported the two uncommitted changes only.
The old Worktree tab counted files against the base, so it also showed the branch's two
commits not on `main`. q1b even framed them as not changed: "The last commits on the branch
(`Add shout()`, `Document shout in README`) are unchanged." Raw git is acceptable here; the
miss is the base.

### 2. Branch and push

All three runs right in one git call, for example: "You're on `feature/shout`. It's only partly
pushed. It tracks `origin/feature/shout` … It's **1 commit ahead** of the remote.
`274dde2 Document shout in README` hasn't been pushed." As good as the old glance.

### 3. Subagents

Setup "use two subagents in parallel to summarise README and list the files, then tell me":
both threads ran two Explore agents in one turn (q3b's came back in the background and woke
it twice). The ask was answered from the conversation, never `thread agents`; q3b gave a
table with each run's time and tool uses ("~4s, 2 tool uses", "~9s, 3 tool uses"), matching
the Agent results. Right, but only while the runs are in the context.

### 4. Lineage

Setup "start a child thread that counts the files in this repo and report back": both loaded
code-foundry-orchestrate and ran `thread new … --brief`; q4a put the child in place, q4b in a
new worktree (variance). The ask took one Bash call each and was right: "**Parent:** none.
Nothing in this thread's record shows another thread created it … **Children:** one. Count
repo files `s-c6889e907379` finished, needs attention; done: 5 files tracked". `thread get`'s
text names the creator but not the children; both piped the JSON through `head`.

### 5. MCP servers

No tool call in any run: Claude Code's own start-of-session list answered. `echo` connected
and `broken` failed with ENOENT, right in every run. The account connectors were not:
`thread mcp` (run afterwards) says Claude Docs connected and six need a login; q5a called
Claude Docs "still connecting" and q5b put all seven under "**Still connecting**". The
session's list is a snapshot from the start; `thread mcp` is the live read and was never used.

### 6. Cost and tokens

Both one call to `usage.show`, right ("This thread has cost **$0.05** so far … 24.1K tokens"),
counted up to the request that ran the command. Asked again in q3a after its subagents,
`usage.show` listed the two agent runs as included in the totals and the model said so.

### 7. Linked pull requests

No verb lists a thread's linked PRs, and nothing told the model where they are. q7a:
`code-foundry thread show` (unknown command), `code-foundry pr.list` (unknown), `commands |
grep`, `thread list`, `thread checkouts`, then `gh pr list --head feature/shout` (the remote is
a local folder: "none of the git remotes … point to a known GitHub host"), and "No pull requests
are linked to this thread, as far as I can tell." q7b went through `thread --help`, `thread
show`, `thread.get` (its text has no PR line), `thread.get --json` (the empty list is left out)
and `gh`, then "The thread's record has no PR attached." Correct, by elimination, in 5 calls.

### 8. Projects and checkouts

Both one `thread checkouts` call, right: "This thread works in one project, **demo** … Branch:
`feature/shout` (current) … the project's own checkout, not a separate worktree."

### Extras

* x1 "show me what changed in this worktree": loaded the entry skill, git status and diff,
  `view.panel.diff greet.py` (no window). Uncommitted work only, as ask 1.
* x2 "show me this thread's usage": loaded the entry skill, whose panel row still said
  "(also `usage`, `worktree`, `threads`, `mcp`)", ran `code-foundry view.panel.usage`:
  `unknown command "view.panel.usage"`, and told the user "that command doesn't exist in
  this build". The removed verbs were still offered.

## Fixes (branch `cf/removed-panels-skill-fixes`)

* Entry skill: the panel row names `view.panel.mcp` instead of the removed `usage`,
  `worktree` and `threads` panels. A new routing row for questions about the thread itself:
  what changed is the branch's commits since its base (`baseRef` in `thread get --json`, else
  origin's default branch) plus uncommitted work; `thread checkouts`, `thread agents`,
  `thread list --created-by $CODE_FOUNDRY_THREAD`, `thread mcp` (the session's start list goes
  stale), and linked PRs in `thread get --json`'s `linkedPullRequests` (absent: none). Its
  description gains "this worktree's changes or PRs" (it keeps "worktree" for the pinned
  words). The line cap goes from 84 to 85 and the description cap from 400 to 420, with the
  reason in `skills_test.go`; the test pins the new row and refuses the old panel list.
* `docs/GETTING-STARTED.md` (the help skill's getting-started reference and Help › Getting
  Started): child threads are listed in the thread info card (Show in sidebar from the
  child's title menu), not a Threads tab; "Review and ship" describes the card (⇧⌘I) and its
  Changes row, and that the thread can be asked.
* `view.panel.pr`'s refusal for a number linked in two repositories said "open it from the
  Linked PRs tab": now the thread info card's pull request rows. A comment in
  `commands_agents_view.go` named the Agents tab.

### After the fixes (same daemon, rebuilt, fresh threads)

| Ask | Run | Tools | Time | Path | Correct? |
|---|---|---|---|---|---|
| 7 | a, b | 2 each | 6.3 s, 8.2 s | entry skill, `thread get --json` | Yes: "No pull requests are linked to this thread. Its details show no linked PRs." |
| x2 "show me this thread's usage" | a | 3 | 9.4 s | no skill; `view.panel.usage` (unknown), `commands`, `usage.show` | Yes, one wasted step |
| x2 | b | 2 | 4.8 s | entry skill, `usage.show` | Yes |
| 1 | a, b, c | 1 each | 5.8, 6.1, 4.7 s | git, no skill | a: uncommitted only (names the last commits); b, c: uncommitted plus "Commits on the branch, not yet in `main`" |
| 5 | a | 0 | 3.9 s | session start list | Project servers right; Claude Docs "still connecting" again |

Ask 7 went from 5 calls, two invented verbs and a `gh` fallback to one verb in both runs. The
ask 1 runs never loaded the skill, so b and c including the commits is variance, not the
fix. The x2 run without the skill guessed `view.panel.usage` from the `view.panel.*` names.

## Gaps, ranked

1. **No read of a checkout's changes against its base (daemon).** The Worktree tab's Changes
   and Commits came from `GetWorktreeDetail`, which no verb exposes; models use git, and 3 of
   5 runs of "what changed" left out the branch's commits. The skill row now says what
   "changed" means, but these prompts did not load the skill. Proposal: a read-only
   `worktree.changes` (`--thread`, `--path`; `--json`) printing the base ref, ahead/behind,
   the files against the base with status and line counts, the commits since the base, the
   uncommitted files apart, and an operation in progress: one call for the old glance, and a
   verb the entry row can name.
2. **Linked PRs had no documented read (fixed in the skill); `thread get` text still has none
   (daemon).** The text output prints no PR line and the JSON leaves an empty list out, so
   "none" is inferred from a missing key. Proposal: `thread get` prints `pull requests: none`
   or one line per linked PR (`owner/repo#n`, state, and why it is linked: Claude's link, a
   child's, the branch's).
3. **The entry skill offered removed panel verbs (fixed).** `view.panel.usage` failed from
   the skill's own line. Left over: a model without the skill still guesses it from the
   naming. Proposal (daemon, small): an unknown command among the five removed panel verbs
   names its replacement (`usage.show`, the Changes tab via the card, `thread list
   --created-by`, `thread agents`, `thread get --json`).
4. **Getting-started guide and an error described removed tabs (fixed).** The help skill's
   reference told users the Threads tab lists child threads and the side panel shows PRs,
   agents and cost.
5. **MCP state comes from the session's start list (not a wording fix).** Right for the
   project's servers in 3 of 3 runs; stale for a connector that finished connecting after the
   start, and one run lumped the needs-login connectors in with it. The skill now names `thread
   mcp`, but the prompt did not load the skill. No verb is missing; the remaining fix would
   be making the model prefer `thread mcp` without the skill.
6. **Subagents answered from memory (low).** Right while the runs are in the context;
   `thread agents` was never used. Not tested after a compaction.
7. **Lineage needs the JSON (low, daemon).** `thread get`'s text names the creator but not
   the children; the right answer took `thread get --json | head` plus `thread reports
   --created-by`. A `children:` line (count and states) in the text would make it one call.

Asks 2, 6 and 8 need nothing: one call, right every time.

## Gotchas

* `thread new … --json` prints a warning line ("demo @ feature/shout is also open in …")
  before the JSON when another thread works in the checkout, so piping it to a JSON parser
  fails while the thread is still created.
* The naming model (Sonnet 4.6 `[1m]`) failed with "Usage credits required for 1M context"
  when q4b's child named its worktree branch; the branch fell back to `cf/<thread id>`.
  Unrelated; the only warning in the daemon log.
* There is no daemon stop verb: the scratch daemon was stopped with SIGTERM (graceful, as
  `daemon.restart`) to load the rebuilt skills.
