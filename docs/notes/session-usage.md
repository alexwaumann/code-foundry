# Session usage, PR 1: daemon fold, pricing, storage, CLI

PR 1 of 4 of `docs/sketches/session-usage/DESIGN.md` (the spec). This PR covers the
daemon half: the fold over a thread's own transcript, its storage, the retired ledger,
pricing, the proto/API fields, the frontend view-model mapping (no UI), `code-foundry
usage`, and the `view.usage` command. Subagent runs (PR 2), the side panel surface (PR
3) and the Usage page (PR 4) follow.

## The invariant

A session's cached usage is only ever **replaced by a complete fold** of its transcript,
never incremented from a partial read. The fold is complete because it starts at byte
zero: either the tailer read the file from its start (a new thread, a fork), or the
prefix the tailer skipped on a resume was rescanned into a fresh fold
(`runner.backfill`), which then becomes the live fold. A crash between a transcript
write and the persist loses at most that window, and the next discovery (every
reconnect and restart goes through one) replaces it. The retired ledger receives a
session's buckets exactly once, in the transaction that deletes the session.

## What was built

* `internal/pricing`: `Rate`, `Lookup(model, tier, speed)`, `Bucket`, `Cost(Bucket)`.
  The DESIGN table verbatim (plus Mythos ids on Fable's rows). Fast mode is 2x on
  opus-5-5, opus-5 and opus-4-8 only; the Haiku 5.5 `long` tier has its own row. An
  unknown model, a tier the model lacks, or `fast` on a model without fast mode are all
  unpriced (`ok=false`), never $0 and never guessed.
* `internal/store/session/usage.go`: `UsageBucket`, `usageFold` (`Line`, `Buckets`),
  `SumUsage`, `Manager.setUsage`. `usage_db.go`: `saveUsage` (delete + insert in one
  tx), `loadUsage`, `loadRetiredUsage`, `retireSession` (upsert-add into
  `usage_retired` + `DELETE FROM sessions`, one tx; `session_usage` cascades).
* Migration `0012_session_usage.sql`: `session_usage` and `usage_retired` exactly as in
  DESIGN (STRICT, the primary keys as specified, cascade on the session).
* `Session.Usage` (copy on write, sorted Day, Model, Tier, Speed), `Snapshot.RetiredUsage`,
  and a `RetiredUsage{Buckets}` bus event published after `Removed` when the removed
  thread had usage.
* Runner: `pollTranscript` feeds every line to the fold; a batch that counted at least
  one new request calls `setUsage` (it compares, persists, publishes). `backfill`
  replaces `backfillLinks`: one pass over the skipped prefix feeds both the pr-link
  merge and a fresh fold. `scanLines` (transcript.go) is the shared line reader;
  `scanPRLinks` uses it now.
* Proto: `UsageBucket` (with per-bucket `cost_usd` and `unpriced`), `Session.usage`,
  `Session.cost_usd`, `Session.unpriced`, `SessionSnapshot.retired_usage`,
  `ListSessionsResponse.retired_usage`, and `SessionEvent.retired_usage`
  (`RetiredUsage`). Priced in `internal/api/session_usage.go`.
* Frontend `src/api/session.ts`: `UsageBucketView`, `SessionView.usage/costUsd/unpriced`,
  the snapshot's `retiredUsage` and a `retiredUsage` event kind. `stores/sessions.ts`
  keeps `retiredUsage` on the store and compares usage by content in `sameSession` (every
  Updated carries new arrays; without it every session update would re-render rows).
* Commands: `usage.show` (CLI: `code-foundry usage [--thread <id>] [--json]`) and
  `view.usage` (ShowView `"usage"`, title "Usage", no chord, next to `view.dashboard`).

## Decisions and deviations from the design

* **Forks: skip the parent's copied records by time.** The design said a fork's fold is
  "right by construction". It is not: `claude --resume <parent> --fork-session` starts
  the fork's file with a copy of the parent's assistant records, usage included, so the
  fork would bill the parent's requests again and the all-threads total would count them
  twice. Seen live (below): the fork showed 2 requests where it had made 1. The copies
  cannot be told apart by id: Claude Code 2.1.296 rewrites `sessionId` on them to the
  fork's id, and `session_id` (another field on each record) is the parent's on the copies
  but, in a 2.1.295 transcript here, also the parent's on the fork's own new requests.
  They do keep their original `timestamp`, which is before the fork was created. So the
  fold has `notBefore`; `spawn` sets it to `CreatedAt` for any thread with a `ParentID`,
  and the rescan fold inherits it. A record without a parsable timestamp is still
  counted (in the `unknown` day).
* **`pricing.Cost` takes `pricing.Bucket`, not `session.UsageBucket`.** The design both
  says the package has no store imports and gives `Cost(session.UsageBucket)`. Kept the
  first; the API layer converts.
* **Prefix match is restricted to snapshot suffixes.** After an exact lookup fails, the
  longest table id that prefixes the model matches only if what follows is a date stamp
  (`-20251001`) or a `[`/`@` suffix. A bare longest-prefix would price a future
  `claude-opus-5-6` as `claude-opus-5`; it is unpriced instead.
* **Per-bucket `cost_usd` / `unpriced` on the wire** (the design had them per session
  only), so PRs 3 and 4 can sum per model and per day without a TypeScript copy of the
  rate table.
* **Retired ledger on the wire**: `SessionSnapshot.retired_usage` and
  `ListSessionsResponse.retired_usage`, plus a `SessionEvent.retired_usage` case after a
  removal (`removed_id` is a bare string, so it cannot carry the ledger).
* **`code-foundry usage` is `usage.show`.** Command names need two segments, so the CLI's
  `resolveCommand` gained one generic rule: when no prefix of the words names a
  command, a prefix naming a domain with a `show` command runs it (`usage` →
  `usage.show`; exact names always win). `usage.show` is CLI-only (`When: ActiveView ==
  ""`, the existing CLI-context test): the palette has `view.usage`, and two "usage"
  entries, one of them a table in a toast, would be noise. Its table: model, requests,
  tokens (all five buckets), cost, share of priced cost; "—" for an unpriced row; then
  the five bucket totals in full. Costs under a cent print four decimals.
* **Unknown day** is the string `"unknown"` (the design's comment allowed `""` or
  "unknown").
* `usageFold.Line` keeps the design's signature; a `requests` counter tells the runner
  whether a batch counted anything.

## Gotchas

* **`/clear`** moves Claude to a new transcript file. Live, the fold carries on across
  the switch. But a later resume rescans only the current file, so usage from before a
  `/clear` is dropped at the next reconnect or restart. Fixing that needs the list of
  transcript files a thread has used, which is not tracked yet; PR 2's per-file folds
  are the natural place.
* **A resume that opens the file mid-line** would lose that one record: the rescan reads
  exactly the skipped prefix (its trailing partial line fails to parse) and the tailer
  starts mid-line. Claude appends whole lines, and on a resume the file exists before
  the process writes, so this has not been seen. `backfillLinks` had the same edge.
* **The tailer resets to byte 0 on truncation** without telling the runner; the fold
  would then double-count. Claude never truncates a transcript.
* Streaming repeats are always consecutive: across all 257 transcripts here, 0
  non-consecutive repeats, so "same as the previous record" is enough.
* The scratch repo for live checks must be under `$HOME`: project paths are home-only
  (`fsx.HomeRoot`), so a repo in `/tmp` cannot be registered. The daemon home can be
  anywhere (`CODE_FOUNDRY_HOME=/tmp/...`).

## Verified

`make check` green (Go: gofmt, vet, staticcheck, all tests; frontend: typecheck, lint,
1082 vitest tests).

Tests: `pricing_test.go` (every table row, dated and suffixed ids, unknown and
newer-version ids, fast, long, unpriced combinations, `Cost`); `usage_test.go` (the
fold over captured lines from `testdata/usage.jsonl`, including a streaming-repeat pair,
a dated haiku id, haiku 5.5, sonnet and a `<synthetic>` record, plus hand-written edge
rows; rescan-plus-live equals the whole fold at every cut; live usage published once per
request and persisted across a restart; a stale persisted value replaced by the rescan on
reconnect; a fork counting only its own requests, live and after its own rescan; Remove
retiring into the ledger, the event, and the ledger surviving a restart; save/load);
`api/session_usage_test.go`; `commands_usage*_test.go`; `TestResolveCommand` rows.

End to end, daemon in `CODE_FOUNDRY_HOME=/tmp/cf-usage1-home`, scratch repo in an
uncommitted `.scratch/usage-repo` inside the worktree (home-only rule above):

```
$ code-foundry repo add <worktree>/.scratch/usage-repo
registered usage-repo (8ac290c892b2)
$ code-foundry session new --worktree <repo> --model haiku --effort medium --name usage-e2e \
    --prompt "Reply with the word ok and nothing else. Do not use any tools."
created thread usage-e2e (s-2083edd6e9ed) in <repo>
$ code-foundry usage --thread s-2083edd6e9ed
Thread s-2083edd6e9ed (usage-e2e): 1 requests · 38.9K tokens · $0.0029

MODEL             REQUESTS  TOKENS  COST     SHARE
claude-haiku-5-5  1         38.9K   $0.0029  100%
TOTAL             1         38.9K   $0.0029  100%

Input 2 · Output 4 · Cache read 25,896 · Cache write 5m 0 · Cache write 1h 13,021
```

(Before the singular fix, hence "1 requests".) By hand: (2×0.10 + 4×0.50 + 25,896×0.01 +
13,021×0.20) / 1e6 = $0.00287; `--json` says `0.00286536`. `grep -o
'"requestId":"[^"]*"' <transcript> | sort -u | wc -l` = 1.

* `daemon restart --yes`, new daemon: `usage --thread … --json` byte-identical to before
  (`cmp`: `IDENTICAL-after-restart`; loaded from `session_usage`).
* `session reconnect` (resume, so discovery skips the history and `backfill` rescans):
  byte-identical again (`IDENTICAL-after-rescan`).
* `session fork`, then one prompt typed through `TerminalService.Write`: with the
  first version of the fork filter (by `sessionId`) the fork showed `2 requests · 80K
  tokens · $0.0052`, the parent's request included. With the time cutoff, after a restart
  (the stale 2 persisted) and a reconnect: `1 request · 41.1K tokens · $0.0023`, cache read
  31,065 = the fork's own `req_011CfupgqccP…`. The stale value was replaced, not added to.
* All threads before removal: `All threads (2): 2 requests · 80K tokens · $0.0052`.
  `session remove` both, then `usage`: `All threads (0 + removed): 2 requests · 80K tokens
  · $0.0052`, same table and bucket line. SQLite: `session_usage` 0 rows, `usage_retired`
  `claude-haiku-5-5|||2026-10-11|2|4|8|56961|0|23040`. After another restart, `usage
  --json` byte-identical (`RETIRED-IDENTICAL-after-restart`).

Large transcripts, the real fold (`scanLines` + `usageFold`) against grep:

| transcript | size | `grep … requestId … \| sort -u \| wc -l` | fold Requests | rescan |
|---|---|---|---|---|
| `bda8bcf8-….jsonl` | 17.8 MB | 70 | 70 | 27 ms |
| `a0f2c402-….jsonl` | 16.7 MB | 83 | 83 | 22 ms |

A GUI built from this branch needs a daemon from this branch for the new fields (an older
daemon simply sends none: empty usage, cost 0). Restart the daemon after installing.

## Usage page (PR 4)

Frontend only; no Go or proto changes. The page over every thread, `view.usage`, as in
DESIGN "Views" and the `?view=all` mockup.

### What was built

* **Views store** (`stores/views.ts`): `usageOpen` next to `settingsOpen`; the two are
  mutually exclusive. `showView("usage")` **toggles** (open if closed, `closeUsage()` if
  open), so the button, the palette and the CLI's `view.usage` all flip it. `closeUsage()`
  mirrors `closeSettings()` (refocuses the selection's terminal). A selection change and
  a top-level page (`showView("pullrequests")` etc.) close it like settings.
  `selectPageOpen` (settings or usage) replaces the bare `settingsOpen` checks: either page
  hides the side panel, and the panel commands are no-ops under it.
* **`view.usage` is presented window-locally** (`keys/bindings.ts`), like `view.settings`:
  the button needs no daemon round trip. The CLI still reaches the window through
  `UiIntent.ShowView "usage"`, which toggles too.
* **Sidebar status row**: a `ChartColumn` `CommandButton` (`status-usage`) right of the
  palette button, `aria-pressed` while the page shows, with the sidebar-accent background
  the toolbar's Dashboard button uses for its current state.
* **`components/usage/`**: `UsagePage` (header with "Code Foundry threads only", the range
  control and ×; hero total, 44px semibold, proportional figures; summary line; chart;
  by-model table; bucket strip), `UsageChart` (inline SVG), `Segmented`, and
  `usageData.ts` (the range filter, daily series, Other folding, axis helpers).
  `useEscapeCloses` moved from `SettingsPage` to `components/window/` and serves both pages.
* **`lib/usage.ts`**: `formatTokens`, `formatUsd`, `formatShare`, `modelColor` (with
  `MODEL_SLOTS`), `bucketTokens`, `sumBuckets`, `byModel`. Kept small and generic: PR 3
  (the side panel surface) creates the same file, so the merge should be a union of exports.
* **ui store**: `usageRange` (1, 7, 30 or 90; default 30), persisted with the sidebar
  width and zoom. A persisted value outside the set falls back to 30. No version bump: an
  older state simply lacks the key.
* **Mock daemon** (`mock/usage.ts`): s-1..s-4 carry two weeks of buckets over four
  models with an empty day; s-3 also has `claude-opus-5`, unpriced; the retired ledger has
  opus 20, 33 and 60 days ago and `claude-opus-4-8` (priced, no colour slot: "Other") 12
  days ago. `view.usage` is in the mock registry.

### Decisions

* **Data**: one `useSessionsStore` subscription (`useShallow`) returns every thread's
  `usage` array plus `retiredUsage`; the page folds them with `useMemo` keyed on that,
  the range and today's UTC date. Buckets are kept by `day` against the range's UTC days
  (today inclusive). Day `"unknown"` buckets never show on the page (they have no slot);
  the CLI still counts them.
* **Thread count** is the live threads with a bucket in the range. Removed threads are in
  the total but not in the count: the retired ledger has no thread ids.
* **Colours** are the mockup's slot colours per scheme (opus-5-5 blue, fable-5-1 orange,
  sonnet-5-5 aqua, haiku-5-5 yellow), by exact model id. Every other id is grey: one
  "Other" series on the chart and legend, but its own row (grey swatch) in the table.
* **Table**: sorted by cost, then tokens. A model with any unpriced bucket gets the
  "unpriced" tag; when it has no priced cost at all, cost and share are "—". Share is of
  the priced total.
* **Chart**: continuous day slots for the whole range (empty days are empty), y grid on a
  1/2/2.5/5 step (about four lines), bars at most 28px wide, a 2px gap between stacked
  segments, 4px radius on the top segment only. Segments too thin to show past the gap
  are left out of the drawing (the tooltip still lists them), so the rounded end always
  sits on a visible segment; without that, a sliver of haiku on top of a bar took the
  rounded corners as a 1px cap. Axis labels: about eight, from the oldest day, always
  today. The chart measures its width (ResizeObserver) rather than scaling a viewBox, so
  text stays 11px. The Tokens / Cost toggle is component state (not persisted).
* **Money**: `formatUsd` prints four decimals under a cent ("$0.0047"), like the CLI, so a
  couple of haiku replies do not read "$0.00".

### Cache savings: TODO

DESIGN puts "Cache savings" (Σ cache read × (input rate − cache read rate)) at the right
of the bucket strip. The GUI has no rate table and the buckets carry only their total
`cost_usd`, so it cannot be computed client-side. The strip ends at Output. To add it,
the daemon would price it per bucket (e.g. `UsageBucket.cache_savings_usd` in the API
layer, next to `cost_usd`), a proto change left for a follow-up.

### Gotchas

* `workspaces.spec.ts` (chromium) has a pre-existing keyboard race: `Meta+n` then
  `Meta+1`/`Meta+3` straight after `openApp`, or Enter before the composer has the base
  ref. On main (89232d3) it failed 3 of 40 runs with `--repeat-each=8`; unrelated to this
  PR. It also failed once in the full `make gui-e2e` here, while binaries were building.
* JSX whitespace: prettier reflowed the summary line's `· <b>` into `·<b>`; the line is
  now built from a list so the separators cannot be lost.

### Verified

`make check` green. Unit tests: `lib/usage.test.ts` (formats, colour slots, sums, model
sort), `components/usage/usageData.test.ts` (UTC days across month ends, range filter
including `unknown`, retired ledger, thread count, empty-day slots, Other folding, axis
step and labels), `UsagePage.test.tsx` (total and summary, unpriced row, bucket strip,
Other on chart and legend with ids in the table, 30/90/1-day switching and persistence,
"No usage in this range", Tokens/Cost with the tooltip, × and Escape), `views.test.ts`
(toggle, exclusivity with settings, top-level pages, `closeUsage`, selection change,
panel commands no-op). `e2e/usage-page.spec.ts` (WebKit and Chromium): button position
and `aria-pressed`, toggle, ×, Escape, selection, settings exclusivity, ShowView from the
CLI path toggling, range filter and reload persistence, Tokens/Cost and the tooltip, plus
`SHOTS=<dir>` screenshots.

Live screenshots, real Wails window at 1400x900: `make build && make gui-build`, daemon
in `CODE_FOUNDRY_HOME=/tmp/cf-usage4-home`, a scratch git repo under the worktree's
`.scratch/` (home-only paths), two haiku threads prompted "reply with the word ok"
(`code-foundry usage`: 2 requests · 77.8K tokens · $0.0047). The GUI started with
`code-foundry gui` and the same home; the window raised by unix id; the status-row button
clicked with a CGEvent mouse click (JXA; AppleScript's `click at` does not reach the web
view); `screencapture -R` of the window. Theme switched with `settings set
appearance.theme light`. A second click on the button closed the page. Afterwards both
threads removed (usage moved to the retired ledger: `All threads (0 + removed): 2
requests · 77.8K tokens · $0.0047`), daemon stopped, home and scratch repo deleted.

* `session-usage/page-dark.png`: tokens, dark.
* `session-usage/page-cost.png`: cost, dark, hovering today's bar.
* `session-usage/page-light.png`: tokens, light.
