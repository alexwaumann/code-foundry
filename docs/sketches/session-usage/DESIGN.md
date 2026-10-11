# Session usage: shape, extraction, display

Sketch for per-session token tracking. Scope: sessions the daemon launched. No reading
of other Claude Code sessions on the machine, no global page. Two views:

* a **Usage** side-panel surface for one thread (`index.html?view=session`)
* a **Usage** main-pane page over every tracked thread (`index.html?view=all`)

## What the transcript gives us

Every API response is one or more `assistant` records in
`~/.claude/projects/<slug>/<claude-session-id>.jsonl`:

```jsonc
{"type":"assistant","timestamp":"2026-10-09T01:38:49.259Z","requestId":"req_011Cfq…",
 "message":{"model":"claude-sonnet-5-5","id":"msg_011C…",
   "usage":{"input_tokens":2,"output_tokens":86,
            "cache_read_input_tokens":990,"cache_creation_input_tokens":2930,
            "cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":2930},
            "output_tokens_details":{"thinking_tokens":0}}}}
```

Facts checked against the transcripts on this machine (2.1.296, 534 files):

* `message.model` is always a canonical id (`claude-opus-5-5`, `claude-fable-5-1`, …) or
  `<synthetic>` (a local placeholder with zero tokens). No aliases. Group by it directly.
* A streamed response is written as **one record per content block**, each repeating the
  same `requestId` and the same `usage`. In one session 80 of 289 request-bearing
  records were repeats. Count each `requestId` once.
* Subagent runs write their own files at
  `<slug>/<claude-session-id>/subagents/agent-<id>.jsonl`, same record shape, with
  `isSidechain: true` and `agentId`. They are the bulk of orchestration spend, so they
  roll up into the parent session.
* Claude Code writes a `cost-state` record (per-model counters and its own `costUSD`)
  rarely: 184 of 241 sessions have exactly one, written near exit. Not live, and not
  used: our fold is the only source.
* Claude Code's price table is inside the minified binary. Nothing on disk exposes it.
  The model catalog cache (`~/.claude/cache/model-catalog`) has names and effort
  options, no prices. We keep our own table.

## Storage

One counter set per (session, model, tier, speed, UTC day). Day granularity is what the chart needs
and is the only grain that cannot be derived from a coarser one; totals are sums.

```go
// internal/store/session/usage.go

// UsageBucket is the token counters for one model on one UTC day of one session.
type UsageBucket struct {
	Model string    // canonical id as written by Claude: "claude-opus-5-5"
	Tier  string    // "" or "long" (Haiku 5.5 prompts over 100K tokens); see Pricing
	Speed string    // "" (standard) or "fast"; see Pricing
	Day   string    // "2026-10-09" (UTC) from the record's timestamp
	Requests     int64
	Input        int64 // input
	Output       int64 // includes thinking tokens
	CacheRead    int64
	CacheWrite5m int64 // cache_creation.ephemeral_5m_input_tokens
	CacheWrite1h int64 // cache_creation.ephemeral_1h_input_tokens
}

// Session gains:
//   Usage []UsageBucket // sorted by (Day, Model, Tier, Speed). Persisted. Copy on write like LinkedPullRequests.
```

Thinking tokens are counted inside Output because that is how they are billed; the
`thinking_tokens` detail is dropped. The two cache-write tiers are kept apart because
they are priced apart.

SQLite, mirroring `session_pull_requests`:

```sql
-- 0012_session_usage.sql
CREATE TABLE session_usage (
    session_id     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    model          TEXT NOT NULL,
    tier           TEXT NOT NULL,  -- '' or 'long'
    speed          TEXT NOT NULL,  -- '' or 'fast'
    day            TEXT NOT NULL,  -- UTC "YYYY-MM-DD"
    requests       INTEGER NOT NULL,
    input          INTEGER NOT NULL,
    output         INTEGER NOT NULL,
    cache_read     INTEGER NOT NULL,
    cache_write_5m INTEGER NOT NULL,
    cache_write_1h INTEGER NOT NULL,
    PRIMARY KEY (session_id, model, tier, speed, day)
) STRICT;
```

Rows are upserted whole per session (delete + insert inside one transaction, same as
`saveLinks`). A session's usage is small: days × models, typically under 20 rows.

Removing a thread cascades its rows away, so the all-threads page is backed by two
tables: live sessions, and a retired ledger with the same key minus `session_id`:

```sql
CREATE TABLE usage_retired (
    model TEXT NOT NULL, tier TEXT NOT NULL, speed TEXT NOT NULL, day TEXT NOT NULL,
    requests INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL,
    cache_read INTEGER NOT NULL, cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL,
    PRIMARY KEY (model, tier, speed, day)
) STRICT;
```

`Store.Remove` adds the session's buckets into `usage_retired` in the same transaction
that deletes the session. The page shows live + retired. Nothing is ever added into a
session's own rows (those are always a fresh fold), and nothing is ever recomputed
into the ledger (it only receives final values at removal), so the two cannot drift.

## Extraction

Usage is a pure fold over the transcript bytes. The store caches the fold; it never
adds to a cached value from a partial read. That one invariant makes restarts, resumes
and forks safe.

```go
// internal/store/session/usage.go

// usageRecord is the subset of an assistant record that usage counting reads.
type usageRecord struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Timestamp string `json:"timestamp"`
	Message   *struct {
		Model string `json:"model"`
		Usage *struct {
			Speed         string `json:"speed"` // "standard" | "fast"
			Input         int64 `json:"input_tokens"`
			Output        int64 `json:"output_tokens"`
			CacheRead     int64 `json:"cache_read_input_tokens"`
			CacheCreation int64 `json:"cache_creation_input_tokens"`
			Tiers *struct {
				M5 int64 `json:"ephemeral_5m_input_tokens"`
				H1 int64 `json:"ephemeral_1h_input_tokens"`
			} `json:"cache_creation"`
		} `json:"usage"`
	} `json:"message"`
}

// usageFold accumulates usage records. Zero value is ready.
type usageFold struct {
	buckets map[usageKey]*UsageBucket
	lastReq string // requestId of the previous record: streaming repeats are consecutive
}

// Line folds one transcript line. Lines that cannot carry usage are rejected by a byte
// search before any JSON decoding (same pattern as parsePRLink): this runs on every line.
func (f *usageFold) Line(line []byte) {
	if !bytes.Contains(line, []byte(`"cache_read_input_tokens"`)) { return }
	var rec usageRecord
	if json.Unmarshal(line, &rec) != nil || rec.Type != "assistant" || rec.Message == nil || rec.Message.Usage == nil { return }
	if rec.Message.Model == "<synthetic>" { return }
	if rec.RequestID != "" && rec.RequestID == f.lastReq { return } // streaming repeat
	f.lastReq = rec.RequestID
	// day from Timestamp (UTC); "" if unparsable -> bucket "unknown"
	// add counters; CacheWrite5m/1h from Tiers, else CacheWrite5m = CacheCreation
}

func (f *usageFold) Buckets() []UsageBucket // sorted (Day, Model)
```

The repeat check is "same as the previous record", not a set of every id seen. Repeats
are always consecutive in the file (they are the chunks of one response), and this keeps
the fold O(1) memory per session.

Where it runs, in `runner.go`:

* **Live.** `pollTranscript` already hands every new line to the detector and to
  `parsePRLink`. It also hands them to `r.usage.Line`. After a batch with at least one
  usage hit, `r.m.setUsage(r.id, r.usage.Buckets())` replaces the session's slice and
  schedules a persist (debounced with the existing status publish; usage changes at most
  once per API response).
* **Discovery with skipped history** (resume, reconnect, daemon restart): instead of
  `backfillLinks`'s "scan the skipped prefix and merge", usage does a **full rescan** of
  the file into a fresh fold, then continues live from that fold. The result replaces
  whatever was persisted. Same for a fork: the forked transcript contains the parent's
  history and Claude bills it again on the first turn only as cache reads, so the fold
  is right by construction.
* **Subagents.** See the next section: each agent run is its own tailed file with its
  own fold, started when the parent's transcript announces it and stopped when its
  result lands in the parent. The session's buckets are the sum of all folds.

## Subagent runs: when to start and stop following

Everything needed is in the parent transcript and the agent files; no process
inspection.

What is on disk per run, at `<project dir>/<claude-session-id>/subagents/`:

* `agent-<id>.meta.json`, written at spawn: `toolUseId` (the parent's Agent `tool_use`
  block id), `agentType`, `description`, `model`, `effort`, `spawnDepth`,
  `requestShape` (`foreground` / `background`).
* `agent-<id>.jsonl`, the run's own transcript: same assistant/usage records, every one
  with `isSidechain: true` and `agentId`. The last record is the final assistant
  message with `stop_reason: end_turn`.

What the parent transcript says:

* The spawn is an assistant `tool_use` block named `Agent`. Its `id` is the meta
  file's `toolUseId`.
* The `tool_result` record for that id carries `toolUseResult` with `agentId`, and a
  `status` of `completed` (foreground: the run is over) or `async_launched`
  (background: the run is in flight). A background run later produces a second
  `tool_result` on a new tool use (the notification), also carrying the `agentId`.

Lifecycle in the runner:

1. **Start.** On a parent assistant record containing an `Agent` tool_use, remember the
   tool use id as pending. On the next poll list `subagents/` and open any
   `agent-*.jsonl` whose meta `toolUseId` is pending (the meta file precedes the
   transcript by a few hundred ms, so a listing can see the meta without the jsonl;
   retry next poll). Each open file gets a `tailer` and a `usageFold`.
2. **Follow.** Each poll drains every open agent tailer after the parent. Agent folds
   are summed into the session's buckets with the parent fold on every publish.
3. **Stop.** Close an agent tailer once the parent has a `tool_result` for its
   `agentId` with status `completed`, or any later `tool_result` naming that
   `agentId` (the background notification), after one final drain. The fold's
   buckets stay in the sum; only the tailer goes away. Nothing in the agent file
   itself is needed to decide this, so a killed or crashed run is also closed by the
   parent's error `tool_result`.
4. **Discovery with skipped history** (resume, reconnect, restart): full rescan of the
   parent decides which agent ids are still pending (tool_use seen, no closing
   tool_result). Every `agent-*.jsonl` in the directory is folded from byte zero;
   pending ones stay open, the rest are folded once and dropped.
5. **Safety net.** An agent tailer with no new bytes for 10 minutes while its parent is
   at the prompt (status idle) is closed. This only matters if Claude Code ever fails to
   write the closing tool_result.

Nested agents (`spawnDepth` 2+) write into the same `subagents/` directory with their
own meta pointing at a tool use inside the parent agent's file, not the session's. Rule
1 only watches the session transcript, so a nested run is picked up by rule 4's
"fold every file" on the next discovery, and live by extending rule 1 to also scan
open agent files for `Agent` tool uses. Cheap, and the same code path. First version:
sessions and depth 1 live, deeper runs on discovery only.

This is the same state the thread's panel can show as "agent runs" later (description,
model, status, cost each), which is why the fold is kept per agent id rather than
merged into one.

Why interruptions cannot corrupt the state: a session's cached buckets are only ever
*replaced* by a complete fold, never incremented from a partial read. A daemon crash
between a transcript write and the debounced persist loses at most that window, and
the next discovery (every reconnect and restart goes through it) rescans from byte
zero and replaces the value. A crash mid-persist is one SQLite transaction and rolls
back. The retired ledger receives a session's buckets only once, at removal, inside
the delete's transaction. So the worst case after any interruption is a stale number
for the seconds until the next rescan, never a wrong one.

Cost of the full rescan: the largest transcript here is ~30 MB and the byte search
rejects almost every line before JSON decoding, so a rescan is tens of milliseconds and
runs once per discovery on the runner goroutine, same as `backfillLinks`.

## Pricing

Rates from platform.claude.com/docs/en/about-claude/pricing (fetched 2026-10-10), USD
per million tokens, Claude API first-party. Partner clouds differ and are out of scope.

| Model id | Input | Output | Cache write 5m | Cache write 1h | Cache read |
|---|---|---|---|---|---|
| `claude-fable-5-1` | 10.00 | 50.00 | 12.50 | 20.00 | 0.25 |
| `claude-fable-5` | 10.00 | 50.00 | 12.50 | 20.00 | 1.00 |
| `claude-opus-5-5` | 4.00 | 20.00 | 5.00 | 8.00 | 0.20 |
| `claude-opus-5` | 5.00 | 25.00 | 6.25 | 10.00 | 0.50 |
| `claude-opus-4-8` | 5.00 | 25.00 | 6.25 | 10.00 | 0.50 |
| `claude-opus-4-7` | 5.00 | 25.00 | 6.25 | 10.00 | 0.50 |
| `claude-opus-4-6` | 5.00 | 25.00 | 6.25 | 10.00 | 0.50 |
| `claude-sonnet-5-5` | 2.00 | 10.00 | 2.50 | 4.00 | 0.10 |
| `claude-sonnet-5` | 2.00 | 10.00 | 2.50 | 4.00 | 0.20 |
| `claude-sonnet-4-6` | 3.00 | 15.00 | 3.75 | 6.00 | 0.30 |
| `claude-haiku-5-5` (prompt ≤ 100K) | 0.10 | 0.50 | 0.125 | 0.20 | 0.01 |
| `claude-haiku-5-5` (prompt > 100K) | 0.50 | 2.50 | 0.625 | 1.00 | 0.05 |
| `claude-haiku-4-5` | 1.00 | 5.00 | 1.25 | 2.00 | 0.10 |

Cache writes are 1.25× (5m) and 2× (1h) input everywhere. Cache reads are 0.1× input
except Fable 5.1 (0.025×) and Opus 5.5 / Sonnet 5.5 (0.05×), so the table is explicit
rather than derived. Mythos ids share Fable's rows if they ever appear. Older ids
(`claude-haiku-4-5-20251001` shows up in transcripts) are matched by prefix after an
exact lookup fails.

Two usage fields change the rate for one request and so become part of the bucket key:

* **Haiku 5.5 long-prompt tier.** A request whose `input + cache_read + cache_creation`
  exceeds 100,000 tokens is bucketed under `claude-haiku-5-5` with `tier: "long"`. Only
  that model has a tier; the field is empty for every other id.
* **Fast mode.** `usage.speed` is `"standard"` or `"fast"`. Fast is 2× on Opus 5.5
  ($8 / $40) and Opus 5 / 4.8 ($10 / $50), cache rates scaled the same way. Bucketed as
  `speed: "fast"`. Claude Code does not expose fast mode on this account today, but the
  field is in every record, so keying on it costs nothing.

`UsageBucket` therefore gains `Tier string` and `Speed string`, both usually empty, and
the SQLite primary key becomes `(session_id, model, tier, speed, day)`.

```go
// internal/pricing/pricing.go (no store imports; used by the API layer and the CLI)

// Rate is USD per million tokens.
type Rate struct{ Input, Output, CacheWrite5m, CacheWrite1h, CacheRead float64 }

// Lookup returns the rate for a bucket's (model, tier, speed). ok is false for an
// unknown model: the caller shows "unpriced", never $0.
func Lookup(model, tier, speed string) (Rate, bool)

// Cost prices one bucket with Lookup.
func Cost(b session.UsageBucket) (usd float64, ok bool)
```

Cost is computed at read time, never stored. "Cache savings" on the all-threads page is
`CacheRead × (Input − CacheRead rate)` summed over buckets. The table is a Go map in
`pricing.go`; adding a model is one line and a test row, and with the two-to-four week
lag before a new model reaches this account that is always done ahead of the first
request.

## API

`SessionService` snapshot: `Session` gains `repeated UsageBucket usage` and the API
layer adds `double cost_usd`, `bool unpriced` (any bucket with an unknown model) per
session. The GUI maps buckets to a view model in `src/api/`; totals and per-model rows
are derived there with narrow selectors.

Overall page: no new RPC. The GUI already holds every session snapshot; the page folds
`usage` across sessions client-side. Day series, per-model table, per-thread table are
all sums over the same buckets. If the number of sessions ever makes that fold heavy,
add a `UsageService.Summary` later; it is not needed for one user.

CLI: `code-foundry usage [--thread <id>] [--json]` prints the same tables (it is a
command in `internal/command`, so the palette gets "Show usage" for free).

## Views

Both views are in `index.html`; `?view=session` and `?view=all`, dark by default
(`?light=1` for light). Chart colours are the dataviz reference palette's dark steps,
validated with the skill's script (see the render note next to the screenshots).

**Session surface** (side panel, 420px): hero cost, tokens and request count beneath,
then a per-model list (name, cost, tokens with share bar), then a token-bucket table
(input, output, cache read, cache write 5m / 1h) with cost per bucket. No chart: a
session is a few hours; the day grain would be one bar. The subtitle counts agent runs
folded in; a per-run list can come later from the same per-agent folds.

**Usage page** (main pane, `view.usage`): header "Usage", then "Code Foundry threads
only", a range segmented control (1 day · 7 days · 30 days · 90 days, default 30, the
choice persisted in the ui store), and an × at the right like the settings page. Body:
hero total spend with tokens, requests and thread count beneath; a stacked daily bar
chart by model with a Tokens / Cost toggle (fixed slot order, anything past four folds
into "Other"); the per-model table (model, requests, tokens, cost, share, "unpriced" tag
for ids missing from the rate table); and one strip of bucket totals with cache savings
at the right. No per-thread table: a thread's cost is on its own panel. The range
filters by bucket day (UTC) client-side; the daemon ships every bucket. Days with no
buckets render as empty slots so the axis is continuous.

**Entry point.** An icon button in the sidebar status row next to the palette button
(`SidebarStatus.tsx`: `status-palette`, `status-settings`), lucide `ChartColumn`,
`data-testid="status-usage"`, bound to a new `view.usage` command (ShowView name
`"usage"`, no default chord). It behaves as a toggle: first click opens the page, next
click closes it, with `aria-pressed` while open. The page's × closes it too. Opening
usage closes settings and vice versa (`usageOpen` next to `settingsOpen` in the views
store, same selection-change and Escape handling as settings).

**Labels.** Token buckets are "Input", "Output", "Cache read", "Cache write · 5m",
"Cache write · 1h". The side panel subtitle is "<tokens> tokens · <n> requests · <k>
agent runs" with no status tag.

Renders: `all.png` (tokens), `all-cost.png` (cost, hovering a day), `all-light.png`,
`session.png`.

## Build plan (2026-10-10)

Opus 5.5 agents, one worktree and PR each. CI green and Alex's confirmation before any
merge; screenshots for approval on anything visible.

1. **usage-1-daemon** — `internal/pricing`, the fold (`usage.go`, table tests on
   captured lines), `session_usage` + `usage_retired` tables and migration, runner
   wiring (live lines, full rescan on discovery), `Store.Remove` retiring, proto
   `UsageBucket` on `Session` plus `cost_usd` / `unpriced` in the API layer, the
   `usage` CLI command, the `view.usage` command. Parent transcript only. Exercised
   end to end with a haiku session. `docs/notes/session-usage.md`.
2. **usage-2-agents** — subagent lifecycle (meta discovery, per-run folds, close on the
   parent's tool_result, rescan rules). Depends on 1.
3. **usage-3-panel** — the side panel Usage surface. Depends on 1.
4. **usage-4-page** — the Usage page, sidebar toggle button, range control, chart with
   Tokens / Cost toggle. Depends on 1.

2, 3 and 4 run in parallel once 1 is on main.
