# Plugin system: design brief (shared by the design agents)

Status: design only, nothing built. Written 2026-10-14 from a conversation with Alex.
Three parallel pieces live in this directory: `PRIMITIVES.md` (the UI primitive catalog
and view-model schema), `index.html` + `shots/` (HTML mockups of two plugins built from
those primitives), and `ARCHITECTURE.md` (daemon, protocol, GUI, lifecycle).

## What a plugin is (decided)

A plugin is a directory with a manifest, an optional executable and (later) optional
static UI assets. The daemon spawns the executable and speaks a versioned protocol to it
(JSON-RPC over stdio, borrowing MCP's shape; the daemon already has such a client in
`internal/claudestream` for Claude's stream-json control protocol). The daemon proxies
for the plugin toward the GUI and CLI. Nothing plugin-ish runs in the frontend except one
generic surface that renders a declarative view model. The pattern is HashiCorp
go-plugin / LSP / MCP, not Go's `plugin` package and not in-process JS.

Any process with `CODE_FOUNDRY_ENDPOINT` + `CODE_FOUNDRY_TOKEN` can already drive the
daemon today. What the plugin system adds is lifecycle (daemon starts, restarts, stops
it), discovery (installed plugins), and registration into the UI and command registry.

## Contribution types (declared in the initialize handshake)

1. **Commands.** The plugin returns command specs; the daemon registers them in
   `internal/command` under `plugin.<name>.<verb>`; Invoke forwards to the plugin.
   Palette, keybindings, CLI verbs and confirm dialogs come for free.
2. **Event subscriptions.** The plugin asks for sources from the daemon's bus (session,
   thread, gh, gitops, repo, …) and the daemon streams them.
3. **Surfaces.** A side-panel tab per declared surface, with an availability predicate
   evaluated by the host from data it already has (e.g. "the selected thread has a PR
   whose checks include a Jenkins URL"). The body is a declarative view model the plugin
   streams; interactions go back as events with action ids.
4. **Thread status.** Raise a thread to needs-attention with a reason (lands in the
   sidebar sort, the dock badge and alert for free).
5. **Session environment hook.** Contribute env vars, MCP server entries, `--add-dir`
   or files to every new session (optionally scoped to a project). This is what makes the
   auth plugin useful; without it, it can only write a file somewhere.
6. **Bridge to the thread.** Plugins invoke existing commands (e.g. `thread.send` with a
   log excerpt, `view.open.url`). Not a new type; listed because it is the killer use.

## UI model (decided: declarative first, iframe tier later)

Server-driven UI: the plugin holds a view model and pushes a new version whenever its
state changes; every interactive element carries an action id; the host sends
`{action, payload}` back on click/submit/change. Flow = replace the view. Elements carry
stable keys so React keeps focus and scroll. Theming, keyboard handling and Alex's
design rules come from the host. The known ceiling is custom rendering (DAG graphs,
charts, drag); a sandboxed-iframe tier served by the daemon under `/plugins/<name>/` is
the planned escape hatch, not part of this design beyond a paragraph.

### Primitive seed list (refine, rename, add or cut with a reason)

text, markdown, status pill, key-value fields, chip row, list (rows with leading dot /
icon, title, meta, trailing actions), log block (monospace, tail-follows, copy), button
(variants: default, muted, destructive; loading state), link, text input, secret input,
select, checkbox/toggle, progress (determinate + indeterminate), section (titled, maybe
collapsible), inline notice (info / amber / red), toast, empty state, divider, spinner.
Also decide: a header primitive matching existing surface headers (`shdr` in
`docs/sketches/mcp-panel/style.css`), forms (grouping inputs + submit, validation
messages), and whether a tabs/segmented primitive is warranted.

## The two example plugins (from Alex's coworkers)

**1. Jenkins pipeline tracker.** Available on any thread whose PR checks link to a
Jenkins pipeline. Polls Jenkins itself. Surface: header (PR number/title, pipeline link,
build number, elapsed), a row of stage chips with status color + duration (Blue Ocean
style), the current/failed stage's log tail, actions Abort / Rebuild / Open in Jenkins,
and "Send failure to Claude" (invokes thread.send with the excerpt). On failure it raises
the thread to needs-attention ("Jenkins: deploy stage failed"). States to mock: running,
failed (with log + send button), succeeded, no pipeline yet / queued, Jenkins
unreachable or needs auth.

**2. Enterprise data auth manager.** Fixes the painful auth setup of an internal
skill/MCP server for non-technical users. Surface: a wizard. States to mock: not signed
in (explain + "Sign in" opens the browser), waiting for the browser (device-code style:
code to copy, spinner, cancel), choose account/environment (select), configuring
(progress + steps list), signed in (green state: account, expiry, Refresh, Sign out,
what it injects into sessions), error (red notice with retry). It contributes a
session-environment hook (env vars + an MCP server entry) so every new session in the
chosen projects just works. Availability: everywhere (it is per user, not per thread);
appears under a project or thread selection, and maybe as a settings entry.

## Alex's design rules (apply to mockups and primitives)

* Tooltips only for information not otherwise visible. Sidebar/panel rows sit 8px from
  the window edge and pane; no inner insets.
* Status colour is amber (needs you) and red (error) only; everything else neutral.
  Tinted text-only tags, no filled badges except the small pills already used.
* Actions are always visible and muted, not hover-revealed, in panel surfaces.
* The panel is 400–420px wide; everything must work at 280px (PANEL_MIN) too.
* Dark and light both first-class. Tokens come from
  `docs/sketches/rendered-thread/style.css` and the panel chrome from
  `docs/sketches/mcp-panel/style.css`; reuse them, do not invent a palette.
* Match the existing surface look (MCP cards in `docs/sketches/mcp-panel/shots/b-*.png`,
  live components under `gui/frontend/src/components/panel` and `components/mcp`).

## Conventions

* Go 1.26, Connect/protobuf, `internal/command` registry, stores as actors publishing
  snapshots (`docs/ARCHITECTURE.md`). Frontend: surfaces registry in
  `gui/frontend/src/surfaces/`, Zustand stores, narrow selectors.
* Do not build anything. Do not commit; the orchestrator commits this directory once.
* Write for Alex: concise, decisions and reasons, tradeoffs stated, open questions listed
  at the end of each document.
