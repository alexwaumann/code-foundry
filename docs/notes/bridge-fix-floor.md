# Bridge fix: the floor by identity, read-only verbs, loopback Host (2026-10-25)

Sandbox testing of phase 3 (the bridge) found four daemon holes. This change closes them.
The GUI side of the same round (host-side limits, cancelling a page's call, the frame and
grant checks) is a separate change.

## 1. The floor compared names, APFS compares folded names

A project symlink to `~/.ßh` or `~/.ſsh` served `~/.ssh/known_hosts` while `.ssh` was 404.
`.conﬁg` reached `~/.config` and `.claude.jſon` reached `~/.claude.json`. A config home whose
name has an `s`, `k`, `fi`… had its token served through the folded spelling (before
`bridge-fix-crosshome.md`'s markers). APFS folds fully (`ß`→`ss`, `ſ`→`s`, `ﬁ`→`fi`, the
Kelvin sign → `k`). `fsx.Within` slices by bytes and then uses Go's simple case folding, and
`filepath.EvalSymlinks` keeps the spelling it was given, so the folded path was "not within"
the guarded tree.

**Fix (`internal/preview/identity.go`):** `Floor.Guarded` keeps the name checks as a fast
path, then decides by identity. It resolves the path's symlinks, stats the path and every
directory above it, and refuses it when any of them is `os.SameFile` with a guarded root:
the known config homes and the credential paths under home, stat'd on every call. They are
not cached: `~/.claude.json` is replaced on every write, and `~/.aws` or a home can appear at
any time. A config home's `worktrees/`, `projects/` and `pages/` stay open, compared by
identity too (by name only when that child does not exist yet). `ScopeOK` also refuses a
tree that is, by identity, home or a directory above a guarded root. Homes found by their
markers needed no change: `Lstat(dir/daemon.token)` goes through the filesystem, which folds.

`F_GETPATH` was not used. It canonicalises one open file, but the floor also answers for
directories and files that do not exist yet (`ScopeOK`, `GrantFile`), and a hard link has
no single canonical path. Identity covers all three.

## 2. Hard links

`ln <home>/daemon.token docs/t` served the live token. A hard link has the guarded file's
identity but not its parent, so the ancestor walk misses it. A regular file with more than
one link is therefore compared against the guarded files: each guarded root that is a file
(`~/.claude.json`, `~/.netrc`…), and every regular file up to two levels below each guarded
directory (a home's token, database and settings; `~/.ssh/*`; `~/.config/gh/hosts.yml`).
A home's open children and `~/Library` are skipped, and the scan stops after 4096 entries.
Only files with more than one link pay for the scan.

**Why the link count alone is not the rule:** plenty of ordinary files have more than one
link. pnpm's store hard-links every `node_modules` file, and `cp -al`, Time Machine
restores and some build tools make them too. Refusing every such file would break a page
in a pnpm project. The count only decides whether to look; identity decides. Not covered: a
hard link to a file deeper than two levels in a guarded folder, or to a file in a home the
daemon does not know up front (found only through its markers, which a hard link's parent
lacks). Git cannot create hard links, so a cloned repository cannot ship one. Making one
takes a local actor that can already read the file.

## 3. Read-only verbs that do work

The marker is per verb, not per call, so a verb with a flag that does work is not read-only:

- `thread.mcp`: it can start a stopped Claude (`--refresh`), asks Claude when nothing is
  cached, writes the database and publishes the change. **Not read-only.**
- `skill.browse --refresh` is `skill.refresh`, and `plugin.browse` fetches the registries with
  `--refresh` or when an index is older than an hour. **Both not read-only.** Splitting the
  refresh out would have removed a flag the CLI and the GUI's Skills page use. A page lists
  skills or plugins from a click instead.

Kept read-only, with the reason in `readonly_test.go`'s comment:

- `pr.checks`: it reads the gh store's cache and asks GitHub only after about 30 s, or once
  the poll saw the pull request move. It goes through the store's one queue, which
  coalesces identical requests. Polling one pull request from a page costs what its PR panel
  costs. There is no per-caller rate: the daemon cannot tell a page's call from the CLI's,
  since a page invokes with the thread's CLI context.
- `thread.wait` and `action.wait`: both end with the request's context. Neither got a
  daemon-side cap for pages, again because a page's call cannot be told apart. Instead,
  `api.TestInvokeCancelReachesTheCommand` checks that a client aborting a Connect `Invoke`
  over HTTP ends the command's context. The GUI aborts a page's call on `cf:cancel`, its
  timeout or the frame going, and the wait's `select` on `ctx.Done()` returns. `action.wait`
  may record a lost terminal run as finished (exit unknown): that records an end the run
  already had, it does not cause one.

## 4. Any Host header (DNS rebinding)

Both TCP listeners now answer only a loopback Host (`internal/daemon/host.go`):
`127.0.0.1`, `localhost` (any case) or `[::1]`, with the listener's own port or none.
Anything else gets **421** before CORS, the bearer check or a grant. That includes another
port, `localhost.`, `0.0.0.0`, `127.1`, a bare `::1`, a v4-mapped address and an empty Host.
A browser sends the Host of the URL it loads, so a rebinding site's requests carry its own
name. The Unix socket is not wrapped (browsers cannot reach it). Everything that talks to
the daemon uses `http://127.0.0.1:<port>` (`client.ReadEndpoint`, the thread env, the GUI,
`pagesOrigin`), and `CODE_FOUNDRY_ENDPOINT=http://localhost:<port>` still works.

## End to end

`make build`, plus `origin/main` built into a temp dir for the "before" run. Each daemon
ran with `CODE_FOUNDRY_HOME=~/cf-fix-floor` and `HOME` set to a scratch home holding fake
`.ssh/known_hosts`, `.config/gh/hosts.yml` and `.claude.json`, so no real credential file
was in reach. The scratch home's `site/` was previewed (`FilesystemService/PreviewFile`; scope
`site`), with `docs/` holding symlinks to `.ßh`, `.ſsh`, `.conﬁg`, `.claude.jſon`, `../../.ßh`
and `.ssh`, and `site/t` a hard link to the daemon's token.

```
                                  main         this branch
GET index.html                    200          200
GET docs/plain/known_hosts        404          404
GET docs/eszett/known_hosts       200 17B      404
GET docs/longs/known_hosts        200 17B      404
GET docs/relative/known_hosts     200 17B      404
GET docs/ligature/gh/hosts.yml    200 14B      404
GET docs/json                     200          404
GET t (hard link to the token)    200 65B      404
API  Host 127.0.0.1:<port>        200          200
API  Host localhost:<port>        200          200
API  Host [::1]:<port>            200          200
API  Host attacker.example:<port> 200          421
API  no Host header               400          400   (Go's server)
pages Host 127.0.0.1:<pages>      200          200
pages Host attacker.example       200          421
pages /cf/bridge.js, localhost    200          200
```

- The CLI over TCP (`CODE_FOUNDRY_ENDPOINT` at `127.0.0.1` and at `localhost`): `daemon
  status` and `thread list` answer.
- The real app: `make gui-build`, `gui/bin/Code Foundry` against a `--dev` daemon (for the
  request log) in the same isolated home. `ui presence` showed 1 window. A no-project thread
  (never sent, so Claude never started) showed `site/index.html` with
  `view.panel.file --focus`. In the log, the webview made 18 RPCs at 200 and 12 preflights at
  204 from `wails://localhost`, and the pages listener served the frame and its `fetch` at
  200. No 421 in the log.
- Mock e2e (WebKit): `bridge`, `inline-html` and `file-tabs` specs, 30 passed and 1
  skipped (`SHOTS` unset). The mock daemon has its own server, so it does not exercise the
  Host check.

## Gotchas

- `./bin/code-foundry help …` auto-starts a daemon in `CODE_FOUNDRY_HOME` with the shell's
  `HOME`. A later `daemon --dev` in the same home then exits ("another daemon is already
  running"). Stop it by the pid holding `daemon.lock` first.
- `httptest.NewRequest` sets Host to `example.com`, so the Host check wraps the handlers in
  `daemon.go` rather than living inside `loopbackHandler`, whose tests build requests that
  way. `TestLoopbackHost` covers the wrapper.
