# MCP panel tab: three sketches

Static sketch of the side panel's MCP tab (`docs/notes/rendered-threads-followups.md` §2):
a rendered thread in the main pane, the panel on the right with an **MCP** tab. Open
`index.html?variant=a|b|c&theme=dark|light`; `node shoot.mjs [a,b,c]` renders
`shots/<v>-<theme>.png` (1440×900 @2x, WebKit) and `-panel.png` crops.

Data is what `mcp_status` returns (status, serverInfo, error, scope, tools with
annotations) plus `source` from `system/init`. Six servers cover every state:
connected (t3-code, github), needs-auth (linear), failed (playwright), pending
(filesystem), disabled (sentry). github's tools are expanded in every variant; tool
annotations show as icons (eye read-only, triangle destructive, globe open-world, pencil
writes). Shared header: plug icon, "MCP servers", "N of M connected", when the status
was last checked (each `system/init`, i.e. the start of a turn) and a refresh button
(`mcp_status` on demand).

* **A: flat list.** One row per server (dot, name, scope chip, version, tool count),
  the status line under rows that need it (amber login hint, red error, "Connecting…",
  "Disabled · not passed to Claude"). Actions (reconnect, disable/enable) appear on hover
  in place of the count, like member rows. Chevron expands the tools.
* **B: cards.** One card per server: name + version, status pill, scope · transport ·
  tools, error/login line, and always-visible muted buttons (Reconnect, Disable or
  Enable) with a tools disclosure on the right. Cards needing attention get an amber or
  red border. Tallest.
* **C: grouped by what needs you.** Sections "Needs you", "Connected", "Disabled".
  Attention rows carry a single amber action button (Reconnect / Retry) inline; connected
  rows show the tool count with hover actions; disabled rows a muted Enable. Two-line
  rows (name, then scope · transport · version or the error).

## Decisions (Alex, 2026-10-12)

**Variant B.** Reconnect is the only action: no Disable/Enable buttons (a server disabled
in Claude's config shows as disabled, nothing to do here; the header's refresh button
re-asks `mcp_status`). Keep the tool annotation icons, each with a tooltip naming the
hint (read-only, destructive, open-world, writes). `shots/b-*.png` are the final state.
