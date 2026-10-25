# Bridge: cf.fetch, a page's HTTP request made by the daemon (2026-10-25)

A page shown in a thread is meant to work as a one-off API client (an internal tracker,
Linear, Jira, Sentry, a company API) with a token the user pastes, keeping its run state in
`cf.storage`. A page's own `fetch` to such an API is blocked by the browser's CORS check
whenever the API does not allow the pages origin (`http://127.0.0.1:<pages port>`), which is
most internal APIs, whatever the token. The daemon is not a browser, so the page asks it to
make the request. Before this the skill said "no cross-origin calls: say a plugin is needed".

## The call

`cf.fetch(url, init?)` in `internal/bridge/bridge.js`, shaped like the Fetch API as far as is
practical:

- `init.method` (GET; upper-cased), `init.headers` (an object, a `Headers`, or pairs),
  `init.body` (a string; a plain object or array is JSON-encoded with
  `Content-Type: application/json`, `URLSearchParams` sent as a form, either only when the
  page set no content-type; anything else, a Blob or a typed array, is `invalid`),
  `init.timeout` (ms, 30 s by default, cut to 120 s).
- Resolves for **every status** with `{status, statusText, ok, url, headers, text(), json()}`:
  `headers` a plain object with lower-case names, `text()`/`json()` synchronous over the
  body, which comes back whole (an `await res.json()` still works). `json()` on a body that
  is not JSON throws a `SyntaxError` naming the host, the status and the body's start (an
  HTML error page is the usual case).
- Rejects with the bridge's `{code, message}`: `invalid` (not an absolute URL, a scheme
  other than http(s), a GET or HEAD with a body, a body over 1 MiB in UTF-8, a refused
  header or host), `failed` (no answer: DNS, TLS, refused connection, more than 5 redirects
  or one to another scheme, a response over 8 MiB), `timeout`, `unavailable` (no thread, the
  bridge not ready). A non-2xx status is not a rejection.
- **No gesture requirement**: it reads someone else's service and changes nothing in Code
  Foundry. The gesture rule stays for Code Foundry's mutations; the skill tells a page to put
  a POST that changes the service in a click handler anyway.
- It goes through the script's run queue: fetches count with runs against the 32 at the app
  (more wait here, their clocks running). The page's own timer is the request's timeout
  plus 5 s, a backstop: the daemon's timeout answers first, as `timeout`; the backstop posts
  `cf:cancel`.

## Messages

Page → host: `{type: "cf:fetch", id, nonce, url, method, headers, body, timeout}`. Host →
page: `{type: "cf:result", id, ok: true, result: {status, statusText, headers, body, url}}`,
or the usual error result. `cf:cancel`, a new document, `cf:bye` and unmount abort it (one
`AbortController` per call, in the same `running` map as runs, so the 32 cap and the
unique-id rule cover it). The host's size cap for a fetch is `BRIDGE_LIMITS.fetchChars`
(1 MiB + 64 Ki characters over url, method, headers and body), past which the message is
ignored like any other too large; the script refuses before that. The contract section of
`bridge-fix-frames.md` and `lib/bridge.ts`'s header list the message.

## The daemon: ThreadService.ProxyFetch

`ProxyFetch(thread_id, url, method, headers, body, timeout_ms) → (status, status_text,
headers, body, url)`, in `internal/api/thread_proxyfetch.go`; the HTTP client is
`internal/proxyfetch` (one `Client` per daemon, made in `daemon.go` with the API and pages
ports). An RPC rather than a verb, like page storage: a page's own read is not a user action
and the CLI has no use for it. Unknown thread: NotFound (`unavailable` to the page).

Errors: `Invalid` → InvalidArgument (`invalid`), `Timeout` → DeadlineExceeded (`timeout`),
`TooLarge` → ResourceExhausted and `Failed` → Unavailable (both `failed` through
`api/bridge.ts bridgeErrorOf`'s default). The caller's cancellation is Canceled and answers
nothing to the page (the host aborted it).

What it sends: the page's method, headers and body, `User-Agent: code-foundry/<version>`
unless the page set one, nothing else. No cookie jar; no Origin; no Code Foundry token (the
client never sees one). Refused headers (InvalidArgument, so a page learns rather than being
silently changed): Cookie, Cookie2, Origin, Host, Content-Length, Connection,
Transfer-Encoding, TE, Trailer, Upgrade, Keep-Alive, Expect, Proxy-*. Accept-Encoding is
dropped instead: the transport asks for gzip and decodes it, so `text()` is always the
decoded body. Response headers come back lower-cased, several values joined with ", ",
Set-Cookie left out.

**No proxy from the environment** (`Proxy: nil`): with a proxy the destination check would
see the proxy's address, not the destination's. A user behind a mandatory HTTP proxy cannot
use `cf.fetch` for hosts only the proxy reaches; not seen so far.

### Destination policy

Allowed: any `http`/`https` host, except an address that reaches this Mac's own services:

- loopback: `127.0.0.0/8`, `::1` (and `::ffff:127.x`, and the NAT64 `64:ff9b::/96` form of
  any refused IPv4 address);
- unspecified: `0.0.0.0/8`, `::`;
- link-local: `169.254.0.0/16` (cloud metadata endpoints), `fe80::/10`, link-local and
  interface-local multicast;
- any address of this machine (its interfaces) on the daemon's own API or pages port. The
  listeners are on 127.0.0.1, so loopback already covers them; the port rule holds if that
  ever changes.

**Other private ranges stay allowed on purpose** (`10/8`, `172.16/12`, `192.168/16`,
`100.64/10`, `fc00::/7`): a company's internal APIs live there (over the VPN), and they are
what `cf.fetch` is for. The cost: a page can reach a LAN device's HTTP interface (a router's
admin page). A page is code the model wrote in the user's own thread, shown on the user's
screen, and it could do the same with a plain `fetch` (CORS stops it reading the answer,
not sending the request), so the daemon adds read access, not reach.

**DNS rebinding:** the transport's `DialContext` resolves the host itself, checks every
address (one refused address refuses the host, before any connection) and dials only those
addresses, so a second answer cannot slip loopback in between check and connect. The
dialer's `Control` checks the address the socket actually connects to once more. Redirects
dial through the same path, so a redirect to `127.0.0.1` is `invalid` too.

### Caps

- Request body 1 MiB (InvalidArgument); response body 8 MiB (read up to 8 MiB + 1, then
  ResourceExhausted "answered more than 8 MiB; ask for less").
- Redirects: at most 5, and only to the same scheme (`http`→`https` included: "same scheme"
  as asked; a page can call the https URL itself). Go drops Authorization (and cookies) on a
  redirect to another domain.
- Timeout: 30 s by default, 120 s at most, through the request's context; it also covers the
  wait for a place under the per-thread cap.
- **8 requests in flight per thread**, the rest wait (a semaphore per thread, removed when
  idle). Waiting rather than refusing: a page that starts 10 reads in a `Promise.all` should
  get 10 answers.
- Cancellation: the page's `cf:cancel` or unmount aborts the Connect call, its context
  ends, and Go aborts the HTTP request (`TestDoTimeoutAndCancel` sees the upstream's request
  context end both ways).

### Logs

Debug only: `page fetch` with method, host, status, duration and the error's cause. Never
headers, bodies, paths or queries (tokens live in all four). Error messages name the host
only, for the same reason: they reach the page, its error strip and "Ask Claude".

## Host (GUI)

`stores/bridgeHost.ts` forwards a `fetch` message to `api/proxyFetch.ts` (`ThreadService.
ProxyFetch`, UTF-8 encoding and decoding of the body, Connect's own `timeoutMs` set 3 s past
the request's so a daemon that never answers still ends). The error strip hears a fetch's
`invalid`, `failed` and `timeout` (not `unavailable`), named `cf.fetch <host>`.

## Words

- `bridge.js`'s header (rendered into the pages skill): one line, `cf.fetch(url, init?)
  Promise of {status, ok, headers, text(), json()}; the app makes it: no CORS`.
- SKILL.md's "No sign-in" limit now routes there: paste a token into a password field, keep
  it in `cf.storage`, send it in a header with `cf.fetch`; any status resolves; localhost is
  refused; plain `fetch` only for an API known to allow any origin. SKILL.md was at its 160
  rendered lines: the "Two shapes" item and the `unavailable` error line were reflowed to
  pay for the header line and the longer limit.
- `reference/sources.md`'s "Tokens" section became "External APIs: cf.fetch and tokens"
  (init, the answer, the errors, what is sent, the refused hosts and why private networks
  work). `reference/examples.md`'s Linear page is on `cf.fetch` with a Refresh button,
  "Forget the key", a 401/403 that asks again and every error shown.
- The capabilities `bridge` rendering line says the same in one paragraph.

## Verification

- Go: `internal/proxyfetch` (table tests for the address rules and own ports; refusals
  before sending: URL, scheme, credentials in the URL, method, GET body, body cap, refused
  headers, loopback v4/v6, unspecified, link-local, one refused address among several, the
  system resolver's localhost; against `httptest`: headers and body sent, no Cookie/Origin,
  User-Agent default and the page's own, Accept-Encoding dropped, Set-Cookie dropped, a 404
  as a response; 5 redirects followed with Authorization kept on the same host, 6 refused, a
  cross-scheme redirect and a redirect to loopback refused; the 8 MiB cap at and past it;
  timeout and cancellation ending the upstream request; 8 per thread, a ninth timing out
  while it waits, another thread not held up, no slots left after). `internal/api`
  (`TestProxyFetch`: response fields, a 418, Unimplemented without a client, NotFound,
  InvalidArgument, ResourceExhausted, Unavailable).
- Vitest: `cfBridgeScript.test.ts` (the message as sent; GET default, a page's own
  content-type, a form; any status resolves, `json()`'s SyntaxError; invalid refusals send
  nothing; no thread is `unavailable`; the app's error; the backstop's `cf:cancel`; fetches
  queue behind 32 runs), `lib/bridge.test.ts` (parse, defaults, the 120 s cut, bad fields,
  a 1 MiB body heard, past the cap ignored), `bridgeHost.test.ts` (forwarded under the
  thread, every status answered, error mapping and what the strip hears by host, cancel and
  bye abort, duplicate id refused, no thread unreported).
- Playwright (WebKit), `bridge.spec.ts`: the mock bridge page fetches the mock's fake
  upstream (`mock/proxyFetch.ts`, `https://upstream.test`): 200 with the issues, a 401 as a
  response, `http://127.0.0.1:7788/…` refused `invalid` on the strip (count 1), a 200 ms
  fetch to `/slow` times out and the mock sees its request aborted.
