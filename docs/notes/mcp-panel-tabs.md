# MCP panel tabs (Connected / Failed / Disabled)

Status: built on branch `cf/mcp-panel-tabs`. `make check` green; `e2e/mcp-panel.spec.ts`
green on WebKit against the mock. No daemon change.

## What changed

* The MCP surface (`components/mcp/McpSurface.tsx`) shows a segmented control under its
  header, full width in the cards' padding: **Connected N · Failed N · Disabled N**, always
  all three in that order (the shared shadcn `Tabs` look of the prompt history scope
  toggle: `h-6 rounded-md p-0.5` list, `rounded-sm px-2 py-0 text-caption` triggers). Only
  the active tab's cards show, in Claude's order.
* Buckets (`lib/mcp.ts` `mcpBucket`, `bucketCounts`, table-tested): Connected =
  connected + pending (connecting), Failed = failed + needs-auth + unknown (none of them is
  up; an unknown status from a newer Claude is safer in front of the user than hidden in
  Connected), Disabled = disabled. The Failed count is `text-cf-error-text` when > 0, the
  other counts muted.
* The header's `N of M connected` (`mcp-count`) is gone; the tabs carry the counts. The
  checked line, Refresh and the stale state are unchanged.
* Empty tabs say so (`mcp-tab-empty`, the surface's `Message` style): "No connected
  servers.", "No failed servers. Nothing needs a login.", "No disabled servers." The
  whole-surface states (Loading…, no status yet, no servers) render instead of the tabs.

## Where the choice lives

`stores/mcpTabs.ts`: a small in-memory Zustand store, panel key → bucket (absent =
Connected). The surface reads its panel key from `PanelKeyContext`, so each thread's
panel remembers its own choice. A `usePanelStore` subscription (the same pattern as
`prPanel.ts`'s inner-tab state) drops a key once its panel holds no `mcp` tab any more,
so closing the MCP tab resets it to Connected; moving the tab to the other split group
keeps it. Not persisted: a reload starts on Connected.

## Gotchas

* A server moves tabs as its status changes: reconnecting a failed server shows
  Connecting… in the Failed tab (the card's own reconnecting state, not its status), then
  it leaves for Connected once the answer arrives. No auto-switch of the tab.
* The e2e helpers that counted six cards now count per tab; `expectStale` checks only the
  shown pills.
* Mock: `POST /__mock/thread/mcp-servers?id=s-r1&keep=a,b` sets the thread's servers to
  the named ones of the fixture's six (always from the fixture, not the current list, so
  calls do not compound), which is how the e2e reaches empty tabs.
