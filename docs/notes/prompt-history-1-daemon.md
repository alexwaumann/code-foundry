# Prompt history 1: the daemon query (2026-10-28)

Two users asked for the Claude Code CLI's up-arrow prompt recall. The needs behind it are
three jobs: see what I asked and whether it was in this thread or another, resend a prompt
after a failure, and pull back an old prompt to iterate on it. This PR is the shared data
source: `ThreadService.ListPrompts`, the `thread.prompts` verb, the mock and the api
mapping. The composer picker and the palette mode come next and build on it. No GUI here.

## Shape

* `ListPrompts(scope, thread_id, project_ids, query, limit)` returns `SentPrompt {thread_id,
  thread_name, item_id, text, sent_at, composer_text}`, newest first. The messages are in
  their own file, `proto/codefoundry/v1/thread_prompts.proto`; only the rpc is in
  thread.proto.
* Scopes: THREAD (thread_id required), PROJECT (the anchor thread's project set, or
  `project_ids`; the two are exclusive), ALL. UNSPECIFIED is INVALID_ARGUMENT. Project refs
  resolve like `thread list --project` (id, unique name, path inside); one that names
  nothing is INVALID_ARGUMENT. An unknown THREAD or anchor id is NOT_FOUND.
* PROJECT intersects project sets (`Thread.ProjectIDs`, which a workspace thread fills with
  its members), not primaries. An empty set matches only empty sets, so a no-project thread
  sees the other no-project threads, and PROJECT with neither a thread nor ids is the
  New-thread composer's "No project" choice.
* `limit` 0 or less is 50; above 500 is cut to 500 (not an error). The CLI refuses outside
  1..500 instead, so a typo is not silently capped.
* `composer_text` was not in the brief: it is the item's composer text with its tag tokens,
  image and PDF chips removed, so the picker can put a prompt back with its chips (job 3).
  Empty when the prompt had no tags (the GUI drops composer text equal to the projection)
  or came from the CLI.

## What counts as the user's prompt

The brief assumed the daemon already recorded who sent a message. It recorded only
`Origin` (user or wake): the phase-0 "provenance" is the skills' provenance line, not
a sender. So this PR adds one: `SendThreadMessageRequest.by_thread_id`, which `thread.send`
fills from `$CODE_FOUNDRY_THREAD` (a `by` arg with `DefaultToThreadEnv`, like
`thread.interrupt --by`), kept on the item as `SentBy` (`sent_by` in the item JSON; no
migration). A created thread's first prompt gets its creator as `SentBy` (through
`PendingFirst.By`, so a daemon stop before the handshake keeps it). Only Claude processes
and action runs get the env; the user's terminals do not, so the user's own CLI sends stay
theirs. Messages from before this PR have no `SentBy` and count as the user's.

Left out, in every scope:

* wake messages (`Origin` wake), messages with a `SentBy`, subagent rows
  (`parent_tool_use_id` set), and messages whose text is empty once attachments are dropped;
* threads a plugin owns (`Owner`): the plugin wrote their prompts (`thread/send` only
  reaches its own threads). THREAD scope on one answers an empty list.

Left out in PROJECT and ALL: hidden child threads (`InSidebar` false under the current
`threads.show_created_threads`). Kept: archived and snoozed threads; a hidden thread in
THREAD scope; the PROJECT anchor itself even when hidden (it is the composer's own thread).

Runs and copies:

* A run of the same text in one thread (consecutive among its listed prompts, so a wake in
  between does not break it) is listed once, as its newest. Compared on the display text.
* A fork copies its parent's items with the same ids. PROJECT and ALL list such an item
  once, under the oldest thread that has it (copies keep the parent's times, so ordering
  cannot tell them apart; the picker swaps the thread when the older copy comes second).
  THREAD scope on a fork lists its copied history as its own.

## Text

`promptText` (prompttext.go) reads the composer text when there is one, else the typed
text. Composer tags become what their chip shows: image and PDF chips dropped (with one
adjacent space, like the composer's `removeReferences`), a skill `/name`, a file its decoded
relative path (no `@`: the brief's "as its path"), a thread its current name (else the
label, else the id), a pull request `#N`, a citation `"<quote>" <comment>`. Typed text gets
`stripFileRefs` (`@cf-file://r/x` becomes `@x`), `[Thread "n" (id x)]` lines become the
name, and citation links the quote; `owner/repo#N` stays as typed. The resume note, seed
prefix, memory refresh, attachment lines and completed thread references never reach the
item's texts, so there is nothing to strip there. `query` matches the display text, so
searching `cf-pr` finds nothing.

## Store and query

* `Manager.ListPrompts` (prompts.go) picks the candidate threads from the snapshot, then
  streams `thread_items` rows `WHERE kind = 'user_message' ORDER BY created_at DESC,
  ordinal DESC` (plus `thread_id = ?` for THREAD, on the primary key) into a pure picker
  that applies the rules and stops once the list is full. It does not go through the
  in-memory logs: loading every thread's items for an ALL query would pin them all in
  `m.threads` and run `closeLostRun` on idle threads as a side effect. User messages are
  written as they are added (`itemWriter.add`), so the table is current; a created
  thread's first prompt shows once Claude took it (until then it lives on the row).
* No index was added. PROJECT and ALL scan the table; `kind` sits before the `data`
  column, so the large tool outputs in overflow pages are not read. Worth an index on
  `(kind, created_at)` if it ever shows up in a profile.
* The handler (internal/api/thread_prompts.go) maps the scope and the fields; nothing else.

## CLI

`thread prompts [--scope thread|project|all] [--thread id] [--project a,b] [--query s]
[--limit n] [--json]`. Without `--scope`: project when `--project` is given, else thread
when there is a thread (`--thread`, `$CODE_FOUNDRY_THREAD`, the GUI's active thread), else
all. `--project` with another explicit scope is refused. Lines are `<age>  <thread id>
<thread name>  <prompt>`, the prompt on one line and cut at 100 characters, like
`thread list`. `NoPalette`, `ReadOnly`, `NoKeybinding`; the three pinned lists in the
command tests gained it. The agents' guide leaves it out (`guide.leftOut`, beside
`thread.restart`): it is the user's history, not an agent's work, and its detailed Thread
entry put the guide 900 bytes over its 25,500-byte soft cap (main had about 50 to spare).
`thread.send --by` is hidden there already ("the CLI sets it").

## Mock

`mock/prompts.ts`: the user_message items of the world's logs (seeded histories plus what
was sent since) and eight fixture prompts on s-1, s-3, s-4 and s-6 (Refactor sidebar tree,
Fix resize race, Investigate flaky e2e, Tidy zshrc), timed relative to each thread's
creation so they never tie, two with composer text (a file tag, a thread tag). The same
scope rules, runs, query and limit; no fork handling and no `SentBy` (the mock's items
have no sender).

## Gotchas

* zsh does not split an unquoted `$args`, so a loop over flag strings passes one argument;
  the CLI's "did you mean" message makes it look like a parsing bug.
* `thread read` still shows a message another thread sent as `you:`; only history reads
  `SentBy` for now.

## End to end (isolated home)

`make build`, a daemon on `CODE_FOUNDRY_HOME=/tmp/pr-a-home`, a scratch repo under the home
directory, threads A and B in it and C without a project (Sonnet 5.5, low effort, one short
prompt each). A got the same prompt again, then a message sent with `--by` B. THREAD on A
listed one prompt (the run folded, the `--by` message left out, while `thread read` showed
all three); PROJECT on A and `--project` listed A and B; ALL added C; PROJECT on C listed
only C; `--query "ok b" --limit 1` listed B. Scratch repo, home and transcripts deleted
afterwards.
