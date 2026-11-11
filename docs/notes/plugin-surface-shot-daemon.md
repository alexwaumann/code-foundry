# plugin surface --shot: the daemon, proto and CLI side

`plugin surface` and `plugin act` printed view JSON only, so an agent writing a plugin could
validate a view but never see it. `plugin surface … --shot out.png [--width 420 --height
900]` now also writes a PNG of the surface as the app draws it. This PR is the contract and
the daemon's half; the Wails host that draws the PNG is a later PR.

## Flow

1. The command runs as before and prints the view (`--json`: the JSON, unchanged).
2. The CLI then calls `PluginService.ShotSurface{ref, instance, min_version, width, height}`
   with the instance and view version it just printed, and writes the returned PNG itself.
   The daemon never writes a file.
3. `internal/shot.Broker` hands the request, with an id, to the one capturer: whoever holds
   `UiService.WatchShots` (the app's host). It waits up to 15 s for `UiService.PublishShot{id,
   png | error, content_height}`.
4. The CLI prints `screenshot: <path> (420 by 900 CSS px, 840 by 1800 px)`, and when
   `content_height` is over the viewport, `the view is 1640 px tall: pass --height 1640` (past
   4000, the most, it says the shot shows the top 4000 px).

With no capturer, ShotSurface fails at once with FailedPrecondition "no screenshot: the app
is not open (code-foundry gui)". The view is already printed; the CLI prints the reason and
exits 1 (not 2: it is no usage mistake). Nothing starts the app.

## Decisions

- **One capturer, the newest wins.** A second `WatchShots` replaces the first, whose stream
  ends with Aborted and whose open requests fail with "the app closed before it answered"
  (Unavailable). Refusing the second would leave a stale stream (a host that reconnected
  before the old one noticed) holding the slot.
- **A disconnect fails the open shots at once**, not at the timeout.
- **Errors by code**: not open, the app's own reason and a bad PNG are FailedPrecondition;
  no answer in 15 s DeadlineExceeded; the capturer leaving, or more than 8 requests queued,
  Unavailable; a PNG over 32 MiB ResourceExhausted. Every message starts "no screenshot: ".
- **Size cap twice**: the broker refuses a PNG over 32 MiB (and one without the PNG
  signature), and UiService's handler reads no message over 33 MiB
  (`connect.WithReadMaxBytes`), so an oversize publish is not buffered whole first. A
  1600 by 4000 viewport at 2x is 12.8 M pixels, a few MiB as PNG.
- **Bounds**: width 280 to 1600, height 200 to 4000, defaults 420 by 900 (`shot.Min*`,
  `Max*`, `Default*`). The command checks them before it opens anything, so the call after
  the view never fails on a size; the daemon checks them again (InvalidArgument) for other
  callers. The CLI sends 0 for an unset side and the daemon fills the default.
- **The request carries the instance and min_version**: the instance GetSurface opened stays
  open for its 10 minute grace, so the host can watch it by key; min_version keeps the host
  from snapshotting a view older than the one printed. The ref (plugin, surface, the CLI's
  context) rides along for the host's chrome.
- **The broker carries the generated `ShotRequest`** rather than a type of its own: there is
  nothing to map, and it still imports no store and nothing from `internal/api`.
- **The CLI hook is a new `cliAfters` registry** in `cmd/code-foundry/plugin.go`, run after
  the result is printed and before a follower (`--shot` with `--watch` shoots, then
  watches). Under `--json` its line goes to stderr so stdout stays one JSON value.

## Pages cannot reach it

- `--shot` is a "CLI:" arg: `plugin.surface`'s Run never reads it, and its backend
  interface (`PluginSurfaceBackend`) has no ShotSurface, so a page's `cf.run("plugin.surface",
  {shot: …})` through the bridge prints the view and captures nothing.
- A page talks only to the GUI by postMessage; the GUI runs registry verbs. `cf:fetch` goes
  through ProxyFetch, which refuses loopback. The API listener refuses the pages origin
  (CORS and the tunnel's origin check), and a scoped token (agent search) reaches only Ping,
  List and Invoke. So neither WatchShots (receiving requests) nor ShotSurface (receiving
  bytes) is reachable from a sandboxed frame.

## Mock daemon

`gui/frontend/mock/server.ts` implements UiService and PluginService partially
(`router.service` takes a partial implementation), so the new RPCs answer Unimplemented
there and nothing needed a change. The frontend shot page PR adds them if it needs them.

## Checked end to end

A scratch `daemon --dev` on its own `CODE_FOUNDRY_HOME`, the `minimal` example linked with
`plugin dev`, a no-project thread:

- no app: `plugin surface minimal status --thread <id> --shot out.png` printed the view, then
  `code-foundry plugin.surface: no screenshot: the app is not open (code-foundry gui)`,
  exit 1, no file;
- a throwaway Go client holding WatchShots and answering with a 2x gradient PNG and
  content height 1640: `--width 500 --height 800` wrote a 1000 by 1600 PNG and printed the
  `--height 1640` hint; `--json` kept the JSON alone on stdout; `--height 100` was refused
  before the surface opened;
- after the client was killed: "the app is not open" again, exit 1.

## Gotchas

- In a test, wait for `WatchShots`' response headers (`stream.ResponseHeader()`) before
  shooting: the handler flushes them only once the stream is the capturer.
- The plugin skill's body is at its byte budget; step 6's clause was paid for by trimming
  "your Bash tool" to "Bash" and the section name after `testing.md`.
