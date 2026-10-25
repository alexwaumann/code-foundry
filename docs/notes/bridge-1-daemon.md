# Phase 3, the bridge, PR 1: daemon, proto, CLI (2026-10-25)

An HTML page the model shows inline (`view.inline`, the GUI's `HtmlFrame`) can call Code
Foundry through `/cf/bridge.js`: run the verbs its thread may run, subscribe to daemon
events, read the theme. The page never talks to the API: every call is page → postMessage →
GUI host → `CommandService.Invoke` with the GUI's own token. This PR is the daemon side; the
GUI host (PR 2) and the skills and system prompt (PR 3) follow.

## What ships

- **A pages listener** (`internal/daemon/pages.go`): a second loopback HTTP listener that
  serves only the preview route, `/cf/theme.css`, `/cf/theme.json` and `/cf/bridge.js`
  (a route map by path prefix, the most specific wins; everything else 404, an RPC with a
  valid token included). The API listener 404s those paths, token or not. The pages
  listener binds first, so its last port cannot have gone to the API; the port goes to
  `<home>/pages.port` (`paths.PagesPort`), written atomically like `daemon.port`.
- **The pages origin is refused by the API's CORS.** `allowedOrigin(origin, pagesPort)`
  refuses any loopback name (`127.0.0.1`, `localhost`, `[::1]`, http or https) on the
  pages port: a page can navigate its own frame to `http://localhost:<pages port>/preview/…`,
  which would otherwise be a different, allowed origin. Other loopback ports (the dev
  frontend) and `wails://localhost` keep working. A preflight from the pages origin falls
  through to the bearer check and is 401 with no CORS headers.
- **The preview's CSP sandbox allows same-origin** (`preview.CSP`). The effective sandbox
  of a framed document is the intersection of the iframe's `sandbox` and the response's CSP
  `sandbox`, so the GUI adding `allow-same-origin` to the frame does nothing unless the
  route allows it too. A page now has the pages origin and keeps its localStorage and
  IndexedDB across reloads and restarts. Still never `allow-top-navigation`.
- **`FilesystemService.PreviewFile`** returns an absolute URL on the pages origin
  (`Filesystem.WithPagesOrigin`). The GUI already joins with `new URL(url, base)`, which
  keeps an absolute URL as it is; the mock still returns root-relative URLs on its one port.
  `/cf/theme.css` in a page and in `view.inline`'s warning is root-relative, so it resolves
  against the pages origin unchanged.
- **`/cf/bridge.js`** (`internal/bridge`): embedded, plain ES2017, no dependencies.
  `text/javascript; charset=utf-8`, `Cache-Control: no-cache` with an ETag of the script's
  hash (a 304 on revalidation, the new script after an update), `nosniff`, any origin.
  The package also holds the protocol's `Version`, `ErrorCodes` and `Sources`, which the
  capabilities text uses.
- **`Command.ReadOnly`** and `read_only` (9) on the `Command` proto message, set on the 44
  verbs that only read. `readonly_test.go` holds the list: every registered command with
  the marker must be in it and every entry must carry it, so a new verb is a change until
  someone adds it on purpose. A table test checks representative reads and changes.
- **Capabilities**: `daemon.capabilities --group rendering` gains a `bridge` line (the
  script tag, `cf.ready`/`thread`/`theme`, `cf.run`, the gesture rule, the error codes,
  `cf.on` and the sources, `cf.onTheme`, auto-resize, `cf.storage`, storage persistence and
  sharing, on-screen only, no SSO in a frame); the group's index line mentions the bridge.
  The `pages` group is the main-pane pages, so it is not there.
- **Mock**: `GET /cf/bridge.js` serves the same file (`mock/bridge.ts`, read from the
  repository like the theme files), so PR 2's test page runs the real script.
- **Tests**: listener reuse and fallback, both handlers' route sets, the CORS rows for the
  pages origin, PreviewFile on a pages origin, the bridge handler, and the script itself
  (`gui/frontend/src/lib/cfBridgeScript.test.ts`: the script run against a fake window
  whose parent records what it posts; Vite's `fs.allow` gains `internal/bridge` for its
  `?raw` import).

## The page↔host message contract (as agreed, unchanged)

Page → host (all carry `cf: 1`):
- `{type:"cf:run", id, verb, args}`  args: object of strings
- `{type:"cf:on", id, source}`   `{type:"cf:off", id}`
- `{type:"cf:resize", height}` (exists)   `{type:"cf:theme:ack"}` (exists)

Host → page:
- `{type:"cf:ready", cf:1, thread:{id,name}, theme:<slot map, same shape as today's cf:theme>, readOnly:[verb names], sources:[names]}` once the frame loads (host posts it on iframe `load`; the script also requests it with `{type:"cf:hello"}` on start in case it loaded first; host answers either).
- `{type:"cf:result", id, ok:true, result:{text, json}}` or `{type:"cf:result", id, ok:false, error:{code, message}}`
- `{type:"cf:event", id, source, event:<JSON view model>}`  (one per event on a live subscription; the first is the current snapshot when the source has one)
- `{type:"cf:theme", ...}` (exists)

Host identifies the frame by `event.source` (the iframe's window), as the resize handler
does today; no nonce.

`cf:hello` carries `cf: 1` like every page message. Error codes: `gesture`, `declined`,
`unavailable`, `invalid`, `failed`, `timeout`. Sources: `thread-list`, `thread` (the
page's own thread's snapshot and pending requests, no items), `gh`, `action`, `plugin`,
`terminal`, `project`, `workspace`, `settings`, `update`, `ui`, `ember`.

## The script's behaviour (what the host can rely on)

- `cf.run(verb, args?, opts?)`: args values may be strings, booleans or finite numbers
  (stringified); `null`/`undefined` are dropped; anything else rejects `invalid`, as does an
  empty verb. The gesture is decided **when `cf.run` is called**, then the call waits for
  `cf:ready` (up to 10 s, else `unavailable`) to learn `readOnly`. A verb not in `readOnly`
  without a gesture rejects `gesture` and posts nothing. Gesture: `navigator.userActivation
  .isActive`; without that API, a `pointerdown` or `keydown` (capture, on window) in the last
  5 s. `opts.timeout` (ms, default 60 000, 0 = none) rejects `timeout` and ignores a late
  result. A result's `json` may be an object or a JSON string (parsed); empty or missing
  is `null`. Rejections are `Error`s with `code` and `message`; a host error without a code
  is `failed`.
- `cf.on(source, fn, onError?)` posts `cf:on` at once (no wait for ready) and returns an
  unsubscribe that posts `cf:off`. `cf.off(source, fn?)` ends that one, or every one to the
  source. Events for an unknown id are ignored. **Tolerated, not required:** a
  `cf:result` with `ok:false` and a subscription's id drops it and calls `onError`
  (else `console.warn`), so the host may refuse an unknown source that way.
- On `pagehide` the script posts `cf:off` for each live subscription: a reload keeps the
  frame's window (`event.source`), so the host should also drop a frame's subscriptions
  when its iframe fires `load` again.
- `cf:theme`: the script sets the slots as custom properties on `<html>`'s inline style
  (and `color-scheme`, only when the page links `/cf/theme.css`), calls `cf.onTheme`
  callbacks, then posts `{type:"cf:theme:ack"}`. **Deviation from the brief** ("acks after
  applying nothing"): acking without applying would leave a stylesheet-only page in the
  old colours, because the ack cancels the reload that repaints it today
  (inline-html-2-fixes.md §3). Inline properties on `:root` win over the stylesheet's
  and every alias in `frame.css` is a `var()` of a slot, so such a page repaints and keeps
  its state. `cf:ready`'s theme is applied the same way (no ack).
- Resize: a `ResizeObserver` on `document.documentElement` and `document.body`, coalesced
  per animation frame, posts `cf:resize` with `body.scrollHeight` plus the body's vertical
  margins, rounded up, only when it changed (measuring the document instead can never
  shrink: inline-html.md). Also once on start and on `load`. `cf.resize(h?)` posts `h`
  (rounded up) or the measurement.
- `cf.storage(prefix?)` throws before `cf:ready` (the thread id is the key prefix:
  `cf:<thread id>:` and `<prefix>:`). Methods: `get` (JSON-parsed, the raw string when not
  JSON), `set` (JSON), `remove`, `keys`, `clear` (only its own keys).
- Messages are accepted only with `event.source === window.parent`. Opened outside a frame,
  `cf.ready` and every `cf.run` reject `unavailable` and nothing is posted. Loading the
  script twice keeps the first `window.cf`.

## "What the owning thread may run"

No new context field. The host invokes with `UiContext{active_thread_id: <page's thread>}`
and **`active_view` empty**, which is exactly what the CLI inside that thread sends, so
availability (`hasThreadOrCLI`, `cliThread`, `canStartThread`'s CLI branch, …) and the
behaviours keyed on an empty view (view.* acting on the thread's own window, memory
provenance, theme checks) are the CLI's. `active_view = "page"` was considered and dropped:
every `ActiveView == ""` branch would then differ from the CLI's. The host fills
`default_to_thread_env` args with the thread id when the page did not give them, and leaves
`default_to_cwd` args unset (a page has no cwd; with a thread in context those verbs use the
thread's placement). A verb on a worktree or terminal needs it in its args, as from the
CLI (`git.push` is unavailable with the thread alone; `TestPageContextIsTheThreadsCLI`).
The `UiContext.active_view` proto comment says so. Confirmation is unchanged:
`ConfirmationRequired` goes back to the host, which asks and re-invokes (`declined` when
the user says no).

## Decisions

- **pages.port is kept on stop. Deviation from the brief** ("remove on stop like the other
  runtime files"): removed on a clean stop, the next start would have no last port to try,
  and a page's origin, so its storage, would change at every restart. Nothing reads the
  file to connect (PreviewFile hands out the URLs), so a stale one is harmless; a missing,
  malformed or out-of-range one, or a taken port, falls back to a free port (logged at info
  for a taken port, warn for a malformed file) and the file is rewritten.
- **Read-only means no side effect at all**: no create, change, send, run, open or write,
  and no moved window (`view.*`, `ui.*` but `ui.presence`, `thread.focus`,
  `thread.previous`/`next`, `worktree.reveal`, `view.open.url`). Refreshes
  (`project.refresh`, `pr.refresh`, `app.update.check`, `skill.refresh`) make the daemon
  work, so they need a gesture. Waits (`thread.wait`, `action.wait`) are reads. Since
  `bridge-fix-floor.md`, `thread.mcp`, `plugin.browse` and `skill.browse` are not (a flag,
  or a stale cache, makes them work). A plugin's own commands are never read-only (the
  manifest has no such field).
- **The API 404s the page routes** rather than 401 without a token, so nothing suggests a
  token would help.
- **Cookies are not port-scoped**, so a page shares cookies for `127.0.0.1` with the dev
  frontend; the API uses no cookies, and the Wails webview is another origin.

## Open questions (for the orchestrator)

- **Sibling frames share the pages origin.** Two pages on screen at once (two threads'
  inline cards, or a card and a File tab) are same-origin with each other, so one can reach
  the other's DOM through `parent.frames` and call its `window.cf`, which the host attributes
  to the other page's thread (with that window's gesture state). What a thread may run is
  the same for every thread (the CLI takes `--id`), so this widens nothing a thread can do,
  but PR 2 may want to know. A per-thread origin (a port or a host name each) would close
  it, at the cost of the stable-origin scheme.
- `docs/ARCHITECTURE.md`'s transport table does not list the pages listener yet (the
  brief keeps this note the only doc in the PR).

## End to end (2026-10-25, built binary, isolated home)

`make build`; `CODE_FOUNDRY_HOME=~/cf-bridge1-home`, the `CLAUDE*` and `CODE_FOUNDRY_*`
variables unset; `~/cf-bridge1-scratch/index.html` linking the stylesheet and the script;
`code-foundry daemon` started and stopped (SIGTERM) three times, then once with the pages
port held by another process:

```
run 1: api port 57192, pages port 57191
--- GET /cf/bridge.js on the pages port
HTTP/1.1 200 OK
Cache-Control: no-cache
Content-Type: text/javascript; charset=utf-8
Etag: "21b41544f7caa574"
--- GET /cf/bridge.js on the API port, no token, then with the token
404
404
--- GET /cf/theme.css: pages port, API port
200
404
--- an RPC on the pages port, with the token
404
--- preflight to the API from the pages origin
HTTP/1.1 401 Unauthorized
--- same preflight from http://localhost:57191
HTTP/1.1 401 Unauthorized
--- same preflight from a dev frontend on another loopback port
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: http://127.0.0.1:9245
--- PreviewFile
{"url":"http://127.0.0.1:57191/preview/0d438ac361ffc6d62b6d287789526621/index.html", "scope":"/Users/alex/cf-bridge1-scratch"}
--- GET that URL
HTTP/1.1 200 OK
Content-Security-Policy: sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads
<!doctype html><title>t</title><link rel="stylesheet" href="/cf/theme.css"><script src="/cf/bridge.js"></script><p>hi</p>
--- read_only in CommandService/List (thread.get, thread.send)
{'thread.get': True, 'thread.send': False, 'view.inline': False} 44 read-only of 193
after stop: pages.port
run 2: api port 57212, pages port 57191
after stop: pages.port
run 3: api port 57214, pages port 57191
after stop: pages.port
--- a taken port: hold the pages port, start again
held 57191; pages port now 57216
last port is taken; pages get a new origin","port":57191,"err":"listen tcp 127.0.0.1:57191: bind: address already in use"
```

The preflights from the pages origin carry no `Access-Control-*` header. After each stop
only `pages.port` is left of the runtime files. The daemon log had no warnings or errors.
The home and scratch folder were removed afterwards.

## Gotchas

- `buf generate` failed once with "internal error" from the remote plugins and worked on
  the next try.
- Under vitest's jsdom, `import.meta.url` in `src/` is not a `file:` URL and `src/` has no
  Node types, so the script test imports it with `?raw`, which needs the directory in
  Vite's `fs.allow` (as the docs and plugin fixtures do).

## Daemon restart

Needed: the new listener, the routes moving off the API port, the CSP, `read_only`, the
capabilities text. GUI and daemon ship together; PR 2's host needs this daemon.
