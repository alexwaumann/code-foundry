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

# Panel surface (PR 3)

The side panel's **Usage** surface for one thread, per DESIGN.md's session view and
`session.png`.

![Usage surface, dark](session-usage/panel-dark.png)
![Usage surface, light](session-usage/panel-light.png)

## What was built

* `surfaces/usage.ts` + `usageTarget.ts`: kind `usage`, title "Usage", lucide
  `ChartColumn`, hotkey **U** (free; the others are f, d, p, l, w, t). Enabled for a
  thread or a thread's terminal (`selectionThread` from `linkedprsTarget.ts`, i.e.
  `deriveContext`), even one without usage; hidden otherwise. One tab per panel, no
  params, follows the selection's thread. Listed after Linked PRs.
* `view.panel.usage` (Go, `commands_view.go`): ShowView `"panel.usage"`, `When:
  hasSession` like `view.panel.linked-prs`, no chord. `stores/views.ts`
  `usagePanelCommand` → `stores/usagePanel.ts` `openUsageSurface`. Unlike Linked PRs
  there is no "nothing yet" toast: a thread without usage opens the surface, which says
  "No usage yet".
* `components/usage/UsageSurface.tsx`: hero cost (32px semibold), "<tokens> tokens · <n>
  requests" (no agent runs yet: PR 2 adds the count), "By model" rows (swatch, mono id,
  "<tokens> tokens · <n> requests"; cost with share of cost beneath), "Tokens" grid (Input,
  Output, Cache read, Cache write · 5m, Cache write · 1h; tokens, muted cost). A model with
  any unpriced bucket gets the "unpriced" tag; one with no priced bucket shows "—" for
  cost and share. Nothing priced at all: the hero and the kind costs are "—" too.
* `lib/usage.ts` (shared with PR 4): `TOKEN_KINDS` (labels and cost fields in display
  order), `totalUsage` and `usageByModel` (folds over `UsageBucketView[]`; per model:
  most expensive first, then tokens, then id), `modelSlot` / `SLOT_COLORS` /
  `modelColorVars` / `SWATCH_BG`, `fmtTok`, `fmtUsd`, `fmtShare`, `fmtRequests`.
* Mock: `mock/usage.ts` seeds s-1 with Opus 5.5 (two days) and Fable 5.1 buckets priced
  from copies of the `internal/pricing` rows; `POST /__mock/usage?session=…&model=…&…` adds
  counters to a (model, day) bucket; `view.panel.usage` in the mock registry.

## Decisions and deviations

* **Per-kind cost on the wire.** The Tokens table has a cost per token kind; the wire
  had one cost per bucket, and PR 1 deliberately kept the rate table out of TypeScript.
  So `pricing.CostByKind` (with `Cost` now its `Total`) and five `UsageBucket` fields,
  `input_cost_usd`, `output_cost_usd`, `cache_read_cost_usd`, `cache_write_5m_cost_usd`,
  `cache_write_1h_cost_usd` (all 0 when unpriced), mapped flat onto `UsageBucketView` so
  `sameUsage`'s field compare still covers them. PR 4's cache-savings figure can use them
  too (savings needs the input rate, which `inputCostUsd / input` gives for a priced
  bucket with input tokens).
* **Token order** follows DESIGN's Labels (Input, Output, Cache read, Cache write 5m / 1h),
  not `session.png` (which put Output last).
* **`fmtTok`** is the mockup's rule, not the CLI's: whole numbers from 100 of a unit
  (980K, 261M, not 980.4K / 261.2M), one decimal below (two for B), trailing zeros
  trimmed (1.5M, not the mockup's 1.50M). `fmtUsd` matches the CLI's four decimals under
  a cent, plus "<$0.0001" for slivers (a haiku "ok" bills 2 input tokens:
  $0.0000002 would otherwise read "$0.0000").
* **Swatch colours without a stylesheet entry.** `modelColorVars` puts the slot's light
  and dark colours on the element as `--sw-l` / `--sw-d`; `SWATCH_BG` is `bg-(--sw-l)
  dark:bg-(--sw-d)` (SVG: `fill-(--sw-l) dark:fill-(--sw-d)`). One table in
  `lib/usage.ts`, no `index.css` edit. Snapshot ids (`claude-haiku-5-5-20261001`,
  `…[1m]`) take their family's slot; anything else is slot 5 (grey).
* **Narrow selector.** Every session Updated carries a new `usage` array, so the
  surface keeps the previous array while `sameUsage` says it is unchanged: a status flip
  does not re-render it.

## Verified

`make check` green (Go incl. `TestCostByKind`, the per-kind assertions in
`TestUsageToProto`, `view.panel.usage` in `TestViewCommandsEmitShowView` and the shared
thread-surface availability table; frontend typecheck, lint, 1241 vitest tests incl.
`lib/usage.test.ts`, `surfaces/usageTarget.test.ts`, `surfaces/usage.test.tsx`).
`make gui-e2e` green incl. `e2e/usage.spec.ts` (U from the empty panel, the numbers of
the seeded thread, "No usage yet" then live buckets, unpriced, the palette, ShowView, a
plain terminal not listing it). `SHOTS=<dir>` saves `usage-panel(-light).png` and
`usage-empty(-light).png` from the mock.

**Live screenshots** (`session-usage/panel-dark.png`, `panel-light.png`): `make
gui-build`; daemon `CODE_FOUNDRY_HOME=/tmp/cf-usage3-home bin/code-foundry daemon --dev`;
a scratch git repo under the worktree (`.scratch/usage3-repo`, deleted afterwards),
`repo add`, `session new --model haiku --effort medium --prompt "reply with the word ok"`
(1 request, 38.9K tokens, $0.0029, same as `code-foundry usage --thread`); `code-foundry
gui` with the same home; `session focus --id <thread>` then `view.panel.usage
--context-session <thread>`; `settings set appearance.theme dark|light` between shots.
Window capture gotcha: with another session's "Code Foundry" running, System Events'
`window 1 of (process whose unix id is N)` resolved to the *other* app (same name), and
Accessibility exposed no windows for ours at all, so it could not be resized. The
1400x900 shots came from a throwaway build with `gui/main.go`'s default window set to
1400x900 (reverted, rebuilt), captured by CGWindowID (`CGWindowListCopyWindowInfo` filtered
by owner pid, then `screencapture -o -l <id>`), which ignores overlapping windows.
