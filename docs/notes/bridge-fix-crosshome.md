# Bridge fix: another daemon's home, and loopback CORS (2026-10-25)

Regression testing of phase 3 (the bridge, #341/#342/#343) found a hole between two daemons
in two homes, which is how this project is tested every day: an isolated test home beside
the real `~/.code-foundry`. The preview `Floor` guarded only the current config home, so
daemon 2 could mint a grant whose tree held daemon 1's home, and a page on daemon 2's pages
listener could fetch daemon 1's `daemon.token`, `daemon.port`, database and logs. Since #342
frames are `allow-same-origin`, that page's origin is `http://127.0.0.1:<daemon 2 pages
port>`, and daemon 1's `allowedOrigin` accepted every loopback origin but its own pages
port, so the page could then call daemon 1's API with the token. Before #342 the frame's
origin was opaque (`null`), which CORS already refused.

## What changed

- **The floor guards every home it can know** (`internal/preview/floor.go`): the current
  config home, the default one (`~/.code-foundry`, `paths.DirName`, even when it is not
  the current one or does not exist), and any directory holding `daemon.token` or
  `pages.port` (`homeMarkers`; `pages.port` survives a stop, so a stopped home counts).
  The markers are looked for on every call, not at start: `Guarded` stats them in the
  path's ancestors up to home, and `ScopeOK` also in the tree's direct children. Each home
  keeps its `worktrees/`, `projects/` and `pages/` open, as the current one did. The rule
  is in `preview-scope-floor.md`.
- **CORS on the API is the Wails webview's, plus dev origins only in dev mode**
  (`internal/daemon/auth.go`). `wails://localhost` (any port: production and `wails3 dev`)
  is always allowed; an `http(s)` loopback origin only when it is in the daemon's dev list,
  which exists only under `daemon --dev`. The pages origin is refused even when listed.
  `null`, any other loopback port (another daemon's pages origin above all), and the web
  get no CORS headers, so the preflight is 401 and the browser never sends the call.

## How the dev frontend is enabled now

- `make dev` (`code-foundry daemon --dev`) allows `http://127.0.0.1:9245` and
  `http://localhost:9245`, the Vite dev server's default port (`WAILS_VITE_PORT`), so
  `pnpm run dev` and `http://127.0.0.1:9245/?daemon=…&token=…` work as before.
- Another port or origin: `CODE_FOUNDRY_DEV_ORIGINS`, comma separated, each a port (both
  loopback names) or an `http(s)` origin on `localhost`, `127.0.0.1` or `[::1]`; it replaces
  the default. The live e2e recipe (`phase2-integration.md`) now starts its daemon with
  `CODE_FOUNDRY_DEV_ORIGINS=9247`. A malformed or non-loopback entry fails the start; the
  variable without `--dev` is ignored with a line on stderr. The daemon logs its
  `dev_origins` in the "daemon started" line.
- A daemon the GUI or the CLI auto-starts never has `--dev`, so it allows no loopback
  origin. `wails3 dev` (`make gui-dev`) needs nothing: its webview is `wails://`.
- The mock daemon (e2e) has its own CORS and is unchanged.

## Decisions

- **`--dev` turns it on, the variable only chooses the origins.** A variable alone would be
  inherited by every daemon a shell (or a thread) auto-starts; the flag is what someone
  types on purpose.
- **Homes are found by marker files, not by a registry of homes.** Daemons know nothing of
  each other, and a test home can appear anywhere under home at any time. Two `Lstat`s per
  ancestor per request is cheap; `db.sqlite` is not a marker because projects use the name.
- **A home deeper than a tree's direct children does not refuse the grant.** Finding it
  would mean walking the tree at every mint. The grant is allowed, every path inside that
  home is 404 at the route (the served path's ancestors hold the marker).
- **A tree with a link to a home among its direct children is refused** (the stat follows
  the link): such a folder gets a one-file grant instead, like any other folder holding a
  home.

## End to end (built binary, two isolated homes)

`make build`; `~/cf-fix-crosshome-1` and `~/cf-fix-crosshome-2`, `CLAUDE*` unset, each
`code-foundry daemon` started by a script that sets its own `CODE_FOUNDRY_HOME`. A scratch
folder `~/cf-fix-crosshome-scratch` with `site/` (links `token.txt` → home 1's token and
`home1` → home 1 at its top) and `site2/` (`token.txt`, and `docs/deep/home1` → home 1
further down). Every PreviewFile below goes to **daemon 2's** API with daemon 2's token;
the CORS rows are preflights (`OPTIONS`, `Access-Control-Request-Method: POST`) and a
POST with the token, to `ThreadService/List`.

**Before, both daemons built from main (e235e955):**

```
--- daemon 2 PreviewFile, a page in daemon 1's home root
{"url":"http://127.0.0.1:50686/preview/958d…/page.html","scope":"/Users/alex/cf-fix-crosshome-1"}
--- daemon 2 PreviewFile, daemon 1's token
{"url":"http://127.0.0.1:50686/preview/958d…/daemon.token","scope":"/Users/alex/cf-fix-crosshome-1"}
--- site/: GET token.txt, home1/daemon.token, home1/pages.port, home1/db.sqlite, home1/logs/daemon.log
200 200 200 200 200
--- daemon 1's API from daemon 2's pages origin (http://127.0.0.1:50686), with daemon 1's token
  preflight: HTTP/1.1 204 No Content Access-Control-Allow-Origin: http://127.0.0.1:50686
  POST+token: HTTP/1.1 200 OK Access-Control-Allow-Origin: http://127.0.0.1:50686
--- daemon 1's API from an arbitrary loopback port
  preflight: HTTP/1.1 204 No Content Access-Control-Allow-Origin: http://127.0.0.1:9245
```

The whole chain in WebKit (Playwright), `site2/attack.html` served by daemon 2: it fetches
`docs/deep/home1/daemon.token` and `daemon.port`, then POSTs to daemon 1's API:

```
origin http://127.0.0.1:50686
read daemon.token: 200, daemon.port: 200
daemon 1 ThreadService/List: 200 {}
```

**After, both daemons built from this branch:**

```
--- daemon 2 PreviewFile, a page in daemon 1's home root
{"code":"invalid_argument","message":"/Users/alex/cf-fix-crosshome-1/page.html is in a protected folder (Code Foundry's own data, credentials or ~/Library), so it cannot be previewed"}
--- daemon 2 PreviewFile, daemon 1's token
{"code":"invalid_argument","message":"/Users/alex/cf-fix-crosshome-1/daemon.token is in a protected folder (…)"}
--- daemon 2 PreviewFile, site/ (links into daemon 1's home at its top)
{"url":"http://127.0.0.1:50686/preview/17a1…/index.html", "scope":".../site/index.html", "singleFile":true}
  GET index.html 200; token.txt, home1/daemon.token, home1/pages.port, home1/db.sqlite, home1/logs/daemon.log 404
--- daemon 2 PreviewFile, site2/ (daemon 1's home linked further down)
{"url":"http://127.0.0.1:50686/preview/773c…/index.html", "scope":".../site2"}
  GET index.html 200; token.txt, docs/deep/home1/{daemon.token,pages.port,db.sqlite,page.html} 404
--- daemon 1's API from daemon 2's pages origin, with daemon 1's token
  preflight: HTTP/1.1 401 Unauthorized
  POST+token: HTTP/1.1 200 OK            (no Access-Control-Allow-Origin)
--- daemon 2's API from its own pages origin          preflight 401, no ACAO
--- daemon 1's API from its own pages origin          preflight 401, no ACAO
--- daemon 1's API from http://127.0.0.1:9245         preflight 401, no ACAO
--- daemon 1's API from null                          preflight 401, no ACAO
--- daemon 1's API from wails://localhost
  preflight: HTTP/1.1 204 No Content Access-Control-Allow-Origin: wails://localhost
```

The POST with the token is answered (the token is valid) but carries no
`Access-Control-Allow-Origin`; a browser never sends it, since `Authorization` makes the
preflight mandatory. In WebKit:

```
origin http://127.0.0.1:50686
read daemon.token: 404, daemon.port: 404
--- the same page handed daemon 1's token and port in its query
daemon 1 ThreadService/List: TypeError: Load failed
```

**Dev mode (daemon 2):** with `--dev` the "daemon started" line logs
`"dev_origins":["http://127.0.0.1:9245","http://localhost:9245"]`; preflights from those
two are 204 with the origin reflected, from `:9247`, daemon 2's pages port and daemon 1's
pages port 401. With `CODE_FOUNDRY_DEV_ORIGINS="9247, http://localhost:5173"` it logs those
three and `:9245` is 401. `CODE_FOUNDRY_DEV_ORIGINS=https://example.com … daemon --dev`
refuses to start (`is not an http(s) origin on localhost, 127.0.0.1 or [::1]`);
`CODE_FOUNDRY_DEV_ORIGINS=9247 … daemon` prints `CODE_FOUNDRY_DEV_ORIGINS is ignored
without --dev` and logs `"dev_origins":null`.

**The browser dev frontend, the documented way:** `pnpm run dev --host 127.0.0.1` (Vite on
9245), opened in WebKit at `http://127.0.0.1:9245/?daemon=…&token=…`. Against daemon 2
(`--dev`): 15 API responses, no failed request, the welcome page and the "dev" status dot.
Against daemon 1 (no `--dev`): every API request failed and the sidebar says "Cannot list
threads: Code Foundry's daemon is not reachable".

**The real app:** `make gui-build`; `gui/bin/Code Foundry` with `CODE_FOUNDRY_HOME` home 1
and `CODE_FOUNDRY_BIN=bin/code-foundry` (daemon 1, no `--dev`, already running). A no-project
Haiku 5.5 (medium) thread "Bridge check" answered "ok"; `gui/frontend/mock/bridge-page.html`
copied to its pages folder and shown with `view.inline <file> --thread <id>`. The frame
loaded from the pages listener: "Shown in Bridge check · dark theme · visit 1",
`thread-list` 1 thread, 2 events. Clicks through CGEvents: Read → `{"threads":1}`; Send a
toast → the app's toast "Hello from a page / Sent through the bridge" and
`{"windows":1,"receivers":1}`. Daemon 1's log: no 401, no warning or error,
`"dev_origins":null`.

The homes, the scratch folder and the scripts were removed afterwards.

## Gotchas

- `pkill -f` on the script that `exec`s the daemon kills the wrapper task, not the daemon;
  stop a daemon by the pid holding its `daemon.lock` (`lsof -t <home>/daemon.lock`).
