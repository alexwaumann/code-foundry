# Agent CLI feedback 2: thread reports, several threads at once

An agent that drove code-foundry from inside a thread reported two gaps (after the
filter fixes of [agent-cli-feedback-1](agent-cli-feedback-1.md)): no aggregate view of
its children's reports (it harvested 12 wake messages one by one), and no bulk remove or
archive (it wrote a shell loop). This step adds `thread reports` and `--ids` on
`thread remove` and `thread archive`.

## Decisions

- **A reports command, not only `thread list --json`.** `thread list --json` has the
  reports, but as whole Thread messages (dozens of fields each, `reportData` as an
  escaped string), and its text has none of them. `thread reports` is a view for the
  supervising agent: one line per child, `-` for one that has not reported (the
  question an agent actually asks is "who is not done yet"), `(data)` when a report
  carries JSON, `--full` to print it indented. Its `--json` is a compact array of
  `ThreadReport` (`id, name, status, createdBy, labels, reportStatus, reportSummary,
  reportData, reportAt`), a plain Go struct (`Result.JSON` uses encoding/json for
  non-proto values), with `reportData` the parsed object (`json.RawMessage`; a string
  should it ever not parse), `reportStatus` `none` without a report, `labels` never
  null. No new RPC: it reads `ThreadService.List` with a `ThreadFilter`.
- **Filters.** `created-by` (with `user`, and suffix resolution shared with
  `thread list` through `resolveCreatedBy`), `label`, `archived`, `all`, `limit`
  (default 0: all), and `status` = a report status or `none`. The filter has no
  report-status field, so `status` and `limit` apply in the command, in the daemon's
  most-recently-active order (limit after the status filter). `all` maps to
  `include_archived`, not `ThreadFilter.all`, so it can never drop `created-by` (the
  daemon's `all` composes since #181, but the command does not depend on it).
- **Several ids, no selectors.** `thread remove` and `thread archive` take `ids`, a
  comma-separated list. No `--label`/`--created-by` selectors on destructive commands
  (decided with Alex): a caller lists ids first (`thread reports`, `thread list
  --json`) and passes them, so what is removed is what it saw.
- **Resolution before anything runs.** `ids` is an `IDList` arg (new `ArgSpec` field):
  Invoke resolves each entry like any thread id (full id, or a unique suffix), drops
  blanks and repeats, and fails the whole call on an entry that does not resolve or is
  ambiguous, so a typo acts on none. Then the backend call runs per thread, past one
  that fails; the message names each failure and the command exits 1. `--json` is
  `{done: [...], failed: [{id, error}]}`.
- **`id` with `ids`.** In a thread `--context-thread` defaults to
  `$CODE_FOUNDRY_THREAD`, so `id` (context-bound) is always "given": with `ids`, `id`
  is ignored, or an agent would remove itself along with its children. `id` is no longer
  `Required` on these two (Run checks one of them is there), and `When` is
  `hasThreadOrCLI`: the GUI still needs a thread in view (it always sends a view),
  the CLI may pass `ids` alone (the `canStartThread` precedent). The GUI and palette
  keep invoking with one id through the context, unchanged.
- **Confirmations count.** Remove always asks: "Remove 12 threads? Claude stops in each
  that runs, and they are forgotten: <ids>", the first 10 and "and N more". One entry in
  `ids` asks as for one thread, naming that id (the `{id}` template would name the
  context thread). Archive asks only when the rule for one thread says so
  (`archiveInterrupts`: mid-turn, waiting on an answer, background agents or shells,
  a pending wake) for any of them, read in one list: "Archive 3 threads? 2 of them are
  busy: two (Claude is still working), s-... (2 background shells are running).".
- **Archive with `ids` archives.** One id toggles; a list may mix archived and not, so
  `ids` archives each, and `--archived=false` unarchives each.
- **Guide.** One bullet for children: list them, and collect their reports with
  `thread reports --created-by $CODE_FOUNDRY_THREAD` (replacing #181's "reports via
  `thread list --json`" line); `--ids a,b,c` on the archive bullet, which now says
  `thread archive --id <id>` (archive takes no positional id; the old text was wrong).
  The `ids` arg gets no line of its own (usage shows `[--ids]`).

## Gotchas

- **The guide's byte budget** (29,000 in the test; the live daemon adds ~50 bytes of
  settings defaults). Main was at 28,995 live after #181, so everything added here had
  to be paid for. Savings: the guide's arg lines no longer repeat the id-suffix help
  (`command.IDHelp`, 8 times) or "(default: the active thread)" (3 times), both of which the
  intro already says (the guide test now checks neither appears); shorter descriptions
  for thread.archive, thread.report, thread.list's created-by and thread.new's
  request-id; the `thread list` bullet lost its filter list (the arg lines have it);
  the `--request-id` bullet is one line. Live guide now: 28,947 bytes. The next addition
  will need cuts again.
- `tabwriter` ends a column block at a line without cells, so `--full`'s data lines go
  in after the rows are aligned, not through the writer.
- The commandtest `Thread` fake lists every thread whatever the filter; `FailIDs` makes
  Remove and Archive fail for chosen ids.
- `code-foundry daemon status` auto-starts a daemon: after stopping the e2e daemon,
  check with `pgrep`, not `daemon status`.

## End to end

`make build`; daemon in `CODE_FOUNDRY_HOME=/tmp/cf-trb-home`; a `--no-project` "Driver"
and three children created by it, all on Haiku 4.5 with no prompt (Claude did no
work); `thread report done` on two with `--id` (one by suffix).

```
$ code-foundry thread report --id s-03ff95ccc33a done "Fixed the redirect after login" --data '{"n":1,"pr":"#12"}'
reported done on thread Fix the login (s-03ff95ccc33a): Fixed the redirect after login
$ code-foundry thread report --id 8bc4d573 done "Docs updated" --data '{"n":2}'
reported done on thread Update the docs (s-38458bc4d573): Docs updated

$ code-foundry thread reports --created-by 46cbe817
s-659ed005115b  -     Bump deps
s-38458bc4d573  done  Update the docs  Docs updated (data)
s-03ff95ccc33a  done  Fix the login    Fixed the redirect after login (data)
$ code-foundry thread reports --created-by s-b0be46cbe817 --full
s-659ed005115b  -     Bump deps
s-38458bc4d573  done  Update the docs  Docs updated
    {
      "n": 2
    }
s-03ff95ccc33a  done  Fix the login    Fixed the redirect after login
    {
      "n": 1,
      "pr": "#12"
    }
$ code-foundry thread reports --created-by s-b0be46cbe817 --status none
s-659ed005115b  -  Bump deps
$ code-foundry thread reports --created-by s-b0be46cbe817 --json
[{"id":"s-659ed005115b","name":"Bump deps","status":"idle","reportStatus":"none","createdBy":"s-b0be46cbe817","labels":["e2e"]},{"id":"s-38458bc4d573","name":"Update the docs","status":"idle","reportStatus":"done","reportSummary":"Docs updated","reportData":{"n":2},"reportAt":"2026-10-18T06:29:45.594Z","createdBy":"s-b0be46cbe817","labels":["e2e"]},{"id":"s-03ff95ccc33a","name":"Fix the login","status":"idle","reportStatus":"done","reportSummary":"Fixed the redirect after login","reportData":{"n":1,"pr":"#12"},"reportAt":"2026-10-18T06:29:44.239Z","createdBy":"s-b0be46cbe817","labels":["e2e"]}]

$ code-foundry thread remove --ids 95ccc33a,8bc4d573 </dev/null      # exit 2, nothing removed
code-foundry thread.remove: Remove 2 threads? Claude stops in each that runs, and they are forgotten: s-03ff95ccc33a, s-38458bc4d573.
Re-run with --yes to confirm.
$ code-foundry thread remove --ids 95ccc33a,8bc4d573 --yes            # exit 0
removed 2 threads: s-03ff95ccc33a, s-38458bc4d573
$ code-foundry thread remove --ids s-659ed005115b,s-03ff95ccc33a --yes   # exit 1
removed 1 thread: s-659ed005115b
failed on 1 thread:
  s-03ff95ccc33a: not_found: thread not found: s-03ff95ccc33a
$ code-foundry thread archive --ids 46cbe817,ffffffff                 # exit 2, nothing archived
code-foundry thread.archive: no thread id ends in "ffffffff"
$ code-foundry thread archive --ids 46cbe817                          # idle: no confirmation
archived 1 thread: s-b0be46cbe817
```

`code-foundry guide` (28,947 bytes), the changed lines:

```
- Your children: `code-foundry thread list --created-by $CODE_FOUNDRY_THREAD`, and their reports in one call:
  `thread reports --created-by $CODE_FOUNDRY_THREAD` (`--json` for the data). `--created-by user`: threads no thread created.
- `code-foundry thread archive --id <id>` puts a finished child away; `--archived=false` brings it back.
  `--ids a,b,c` acts on several, here and in `thread remove`.
- `thread.archive [--id] [--ids] --yes` Archive a thread: ...
- `thread.remove [--id] [--ids] --yes` Forget a thread, stopping Claude first if it runs.
- `thread.reports` The reports of threads, for the thread that created them: one line each (`-`: no report yet; `(data)`: it has JSON data, see full). --json: one object each, reportData parsed.
```
