# WebSocket tunnel: the daemon side

GUI streams run on fetch over HTTP/1.1, and WebKit's six connections per origin cap how many
can be live. WebSockets do not count against that cap. This is PR 1 of six: the route only.
Nothing uses it yet, so the GUI behaves as before. Unary calls, the CLI, Claude inside threads,
plugins and the Wails host stay on Connect over HTTP.

## Shape

`internal/wstunnel`, mounted at `/stream/<procedure>` in `loopbackHandler`, under `loopbackHost`
and outside `cors`. The wire is in the package comment. The tunnel owns no RPC: it replays the
call as a synthetic POST through `requireBearer` and the mux, so a new stream needs no change
here. A later PR puts a `fetch` shim under connect-web's `createConnectTransport`, which reuses
its framing and error mapping.

## What is checked, in order

| Step | Check | Refused with |
| --- | --- | --- |
| Host | `loopbackHost` | 421 |
| Origin | exactly one header, `allowedOrigin` | 403 |
| Path | a registered server-streaming procedure, nothing percent-encoded, no query | 404 |
| Drain | not shutting down | 503 |
| First frames | text head, binary body, 64 KiB each, 5 s for both | close 1008, 1009, or none at the deadline |
| Token | `requireBearer` with the head's `Authorization` | 401 or 403 in the response head |

Origin comes before the token and does not read it, so a leaked token does not help a page. A
browser cannot read a failed upgrade's status, so only the token check answers through the head:
connect-web then reports `Unauthenticated` or `PermissionDenied` from the status.

## Decisions

- A unary or client-streaming procedure is 404 before the upgrade, not an error in the head. It
  can then never run over the tunnel, whatever the token. The price is that a client bug shows
  as a failed socket, not `Unimplemented`. The check reads the protobuf registry, so a new stream
  passes on its own, and a path that names no procedure (`/stream/preview/...`) cannot reach
  another route.
- The head's headers are allow-listed and the others dropped, not refused, so a header a future
  connect-web adds does not break every stream. `User-Agent` and the gRPC headers are dropped.
  `Host`, `RemoteAddr` and `Origin` come from the upgrade: no middleware under the tunnel can
  read a client's value for them.
- Header values are not checked for CR or LF: the synthetic request is never serialised.
- A refused Origin logs at Info: it is what the managed Mac milestone needs to see, and a browser
  can only send its real origin.

## Check-then-use

Each value is validated once and that same value is used:

- Two `Origin` headers are refused, since `Get` would read only the first.
- The path is checked once. The request's URL is built from that string, not parsed, so
  `%3F` or `%23` cannot turn into a query or fragment after the check, and `requireBearer`'s
  `AllowProcedure`, the mux and the log all read the same string.
- Two spellings of a header in the head (`Authorization`, `authorization`) are refused. Map order
  would otherwise choose which one the bearer check reads.
- The upgrade's own `Authorization` is ignored: only the head's reaches the bearer check.

## Gotchas

- `CloseRead` does not fit, despite being the obvious call, so `readUntilGone` replaces it:
  - It closes the socket when its context ends. Given the request context, it kills the socket at
    SIGTERM before the end of stream is written, even if the final write is detached.
  - On a data message it calls `Close` from its own goroutine, which by the library's source
    waits 5 s for the read lock it holds, then 15 s for itself to exit. The handler was still
    running after 8 s, when the test gave up.
- `Close` waits 5 s for the client's answer, and `CloseNow` cannot interrupt a running `Close`.
  Closing the hijacked `net.Conn` does: that is how `hangUp` bounds it.
- `Write` closes the socket when its context ends, so no write may run on the handler's context.
- Connect writes the end of stream and flushes it inside the handler, not after it returns. So
  the "final flush" has no call site of its own: every `send` is detached and gets `WriteTimeout`,
  or `FinalTimeout` counted from when the handler's context ended or the write began, whichever is
  later. That also stops a stuck client holding shutdown for the rest of its 30 s.
- `Server.Shutdown` does not wait for hijacked connections: `Drain` runs before the stores close.
  It shares `shutdownCtx`, since tunnels were cancelled at the same moment as the servers.
- `coder/websocket` finds the hijacker through `Unwrap`, so `statusRecorder` needs no change. The
  boundary table runs at both log levels to keep that true.
- A response buffer over 1 MiB is dropped after its flush: a 49 MB thread snapshot would
  otherwise stay allocated for the life of an idle stream.

## Not covered

- No scoped token reaches a stream today: `AllowProcedure` lists unary procedures only and the
  tunnel refuses those. The denial is tested; a scoped token passing through the tunnel cannot be.

## Verified

Against `daemon --dev` on a scratch home, with connect-web's own client over a real WebSocket:
`EventService.Watch` held, snapshots and a live `settings` event received, a bad token reported as
`Unauthenticated`, and SIGTERM ended the stream cleanly with close 1000, `tunnel closed` logged
before `closing stores`. curl with forged headers: 403 for no Origin, `null` and the pages origin
(both with the real token on the upgrade), another loopback port, a lookalike scheme and two
Origins; 421 for a forged Host; 404 for unary, encoded paths and a query, and on the pages listener
and the Unix socket; 307 for a dot segment, which `ServeMux` only redirects; 426 for a POST with a
valid token and no upgrade.

- `Conn.Close` is not bounded by itself. After an oversized message the library has only sent its
  close frame, and `waitCloseHandshake` then skips the rest of the frame with no deadline, so a
  client that declares a big frame and stops sending held a tunnel, with no token, past every
  timeout. Ending the read does not reach it. `hangUp` closes the hijacked `net.Conn` from its
  timer, which `hijackCapture` keeps from `Accept`.
