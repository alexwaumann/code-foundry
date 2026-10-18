# Panel polish: tooltip height, markdown tags, tabs only when there is something, stale MCP (2026-10-18)

Four small GUI items in one PR (`cf/panel-polish`). No daemon or proto change.

![MCP tab, stale, dark](panel-polish/mcp-stale-dark.png)
![MCP tab, stale, light](panel-polish/mcp-stale-light.png)

## 1. Agents tab tooltips stop at five lines

* The shared `Tip` (`components/ui/tooltip.tsx`) takes `maxLines`: the label is wrapped in
  a span with `line-clamp-(--tip-lines)` and `--tip-lines: N` as an inline custom
  property. A CSS variable rather than `line-clamp-5` so any N works without listing
  literal classes for Tailwind's scanner; jsdom keeps custom properties, so the unit test
  can read it (`style.getPropertyValue`), where `-webkit-line-clamp` set as a style
  property is dropped. Absent: unlimited, the label is not wrapped at all.
* `AgentsSurface` uses `maxLines={5}` on the `whenTruncated` tips of a done run's summary
  and a failed run's error. The row itself still clamps at two lines; the tooltip shows
  three more and an ellipsis instead of the whole report.

## 2. `small`, `mark`, `ins` and `s` in markdown

* `components/pr/Markdown.tsx`'s sanitize whitelist gains the four tags. `index.css`:
  `.cf-markdown small` is `@apply text-caption` (13px muted, so in a File tab's 15px body
  it reads smaller, in a PR body the same size but muted); `mark` is the highlight token
  at 22% behind inherited text, 4px radius; `ins` underlined, `s` struck (stated, not
  left to the UA, in case a reset touches them).
* **Gotcha: Claude's answers render HTML as text.** The thread view (`ThreadMarkdown`,
  `components/thread/Code.tsx`) passes `html: false` on purpose ("Result<T, E>" must not
  vanish; like Claude Code's own UI), so `<small>` in a thread shows as the literal
  `<small>…</small>`, before and after this change. The whitelist applies where raw HTML
  is parsed: PR descriptions and comments, the File tab's markdown preview, the guide.
  A test pins the thread behaviour. Rendering a few inline tags in threads would mean
  reversing that decision; not done here.

## 3. Agents and Threads listed only when there is something

* `surfaces/agentsTarget.ts` `selectionAgentsThread`: the selected thread when the thread
  list's `agentRuns` is non-empty (runs persist, so a stopped thread with runs still
  lists it). `surfaces/threadsTarget.ts` `selectionThreadsThread`: the selected thread
  when `lib/lineage.ts` `hasLineage` (a creator, removed ones included since the panel
  keeps their row, siblings, or children). Otherwise **hidden**, not disabled (Alex's
  call).
* `watches` stays `[useThreadsStore, useProjectsStore]`: both answers come from the
  thread list, so a first run or a new child lists the entry live (tested). The strip
  above the composer reads `backgroundAgentsRunning` from the same thread-list message
  that carries `agentRuns`, so it never shows before the surface is enabled.
* **Entry points.** The panel's letters (A, H) follow availability already
  (`panel/keys.ts`). The header's "from …" chip only shows for a thread with a creator,
  and the Agents strip only while background runs go, so both always find the surface
  enabled. `view.panel.agents` / `view.panel.threads` (palette, CLI) follow the Linked
  PRs precedent: for a thread without runs or lineage they toast "No agents yet" / "No
  related threads" with the empty state's explanation and open nothing; still a no-op
  with no thread selected. The daemon still offers the commands for any thread (it does
  not know the GUI's lists); the toast is the answer. `thread.agent.open` (the timeline's
  "Open ›") opens the subagent view, not the tab, and is unchanged.
* **An open tab stays.** Availability gates the empty list, the letters and the commands,
  never open tabs (the panel never pruned by it), so a tab restored with the panel or
  opened before the lineage went away keeps showing, with its empty state ("No agents
  yet…", "Created by you. No threads created from here…"). Those empty states stay for
  that reason.
* Mock: `threadMsg` now carries `agentRuns` (`mock/agents.ts` `listRuns`, open/closed from
  the log's runs), so the mock's agents thread lists the surface like the daemon's.
* Test fixtures that cast partial `ThreadView`s gained `agentRuns: []`: every surface's
  `available` runs for the empty list, and the Agents one now reads it.

## 4. MCP staleness

* `lib/mcp.ts`: `mcpStale({ checkedAtMs, running, refreshing }, now)`: stale when Claude
  is not running for the thread (`claudeRunning`: state not connected or starting) or the
  check is `MCP_STALE_AFTER_MS` (10 min) old or more; never while a refresh is in flight.
  An unknown check time is stale only when Claude is not running. `staleLine`: "Last
  check 12 min ago · may be out of date". Table tests for all three.
* `stores/mcp.ts` `useMcpStale(threadId)`: false without a status (the empty state talks
  then). The clock is `lib/clock.ts`'s new `useNowSelect(5000, now => …)`: the shared 5 s
  clock re-evaluates the boolean, and React re-renders only when it flips
  (`useSyncExternalStore` compares the snapshot), so the cards do not re-render every
  tick and the state flips at most 5 s after the 10 min mark, without interaction.
* `McpSurface`: computed once and passed to the header and the cards. Stale: the checked
  line (clock icon included) is `text-warning`, its text the stale line; the pills drop
  their status tint for `border border-dashed border-muted-foreground/50
  text-muted-foreground` (the label stays, the dot and the card borders keep their
  colours); Refresh becomes a shadcn `Button size="xs"` (primary) with the icon and the
  word "Refresh" and no tooltip (nothing hidden). Not stale, the quiet icon button with
  its tooltip as before. A refresh in flight is never stale, so the spinning state is
  always the icon button.
* No new RPC: `checkedAtMs` from the Watch, the state from the thread list.
* A stopped thread is stale at once, even with a check seconds old: after the idle stop
  Claude no longer checks, so nothing says the list is current. A refresh starts Claude
  (the daemon's behaviour), which clears it.
* Mock: `POST /__mock/thread/mcp-age?id=s-r1&ago=720` backdates the last check
  (`mock/mcp.ts` `ageMcp`), published like a new answer. e2e: stale after aging, cleared
  by Refresh; a stopped thread stale at once; the SHOTS run also saves
  `mcp-stale-<scheme>-panel.png`.

## Verified

* `make check` green; `make gui-e2e` on Chromium plus WebKit for the touched specs
  (lineage, mcp-panel, panel, agents-panel, addproject). Two failures elsewhere were
  timing flakes that passed on rerun (`panel.spec.ts` tab drag reorder,
  `addproject.spec.ts` Local folder Enter), as was Go's `TestRenderedStartCrash` once
  under load.
* Live, built app (`make gui-build`) with an isolated `CODE_FOUNDRY_HOME`, a plain scratch
  folder project and Haiku 5.5 threads (`claude-haiku-5-5[1m]`, medium): a thread that ran
  one subagent and created a child lists Agents and Threads; a plain thread lists neither,
  and Related Threads from the palette toasts "No related threads". With
  `threads.cache_ttl_seconds` at 60 the thread stopped on idle and the MCP tab flipped to
  stale on its own (screenshots above); `thread mcp --refresh` started Claude and the
  header went back to "Checked just now".
* **Gotcha (daemon, not changed):** that refresh's first answer, right after Claude
  started, listed no MCP servers ("0 of 0 connected"); the next turn's check would bring
  them back. Before this PR the refresh had the same answer, just without the stale
  state around it.
* Not checked live: the Tip clamp (no way to hover from a script; the unit test reads
  the clamp) and `<small>` in a File tab preview (unit tests).
