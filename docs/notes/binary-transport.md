# Binary on the wire

A large thread took 200 to 450 ms to open after `thread-open-stall.md`. The GUI was asking for
JSON: `createConnectTransport` defaults to it, and `api/endpoint.ts` never said otherwise. Every
RPC went out and came back as JSON, while the CLI and the Go host used binary.

## Measured

Real Wails window, scratch home, threads built from real transcripts. Time to the first event of
a 49 MB thread, one layer at a time:

| Layer | Time |
| --- | --- |
| bytes in | 31 ms |
| plus Connect's envelope reader | 39 ms |
| plus binary decode | 59 ms |
| plus view mapping | 60 ms |
| `watchThread` as the app called it (JSON) | 361 ms |

Selection to rows painted, median of 7:

| Snapshot | JSON | Binary |
| --- | --- | --- |
| 1 MB | 110 ms | 84 ms |
| 8 MB | 151 ms | 88 ms |
| 16 MB | 222 ms | 104 ms |
| 18 MB | 225 ms | 116 ms |
| 32 MB | 318 ms | 131 ms |
| 49 MB | 425 ms | 132 ms |

## Decisions

- **Binary in development too.** The e2e build, `make drive` and `wails3 dev` are all development
  builds, so a split would leave tests running what users do not, and timings that mislead.
  `?json=1` (development builds only) reads the traffic as JSON when wanted.
- **No two-stage fetch.** Sending only what folded turns show first would save 20 to 40 ms on the
  largest threads, and folded turns are not self-contained: a header's step count and which text
  is final come from the hidden items.

## Behaviour

Both formats were compared against a real daemon: 79 read-only calls, 47 of them error replies,
and whole snapshots up to 32 MB. The only differences were `Ping`'s uptime and map key order.

Seen live over binary, in the real window: a Claude turn streamed in 95 steps and ended with the
daemon's seq and text exactly (an emoji and an accented word included). A real terminal's
`bytes` went both ways: text sent with `Write` came back through `Attach` intact.

One real change: a lone surrogate in a string (half an emoji) made the daemon refuse a JSON
request; in binary it arrives as U+FFFD and the request goes through. Invalid UTF-8 from the
daemon fails the same in both.

## Gotchas

- Nothing else notices a fall back to JSON: the app works, only slower. `api/endpoint.test.ts`
  pins the format.
- Timings taken with raw binary requests do not show what a JSON client pays. That is how this
  stayed hidden through the stall work.
- The inspector shows binary bodies now. Use `?json=1`.
