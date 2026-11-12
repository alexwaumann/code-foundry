# Shell PR 3: the layout store, LayoutService and the layout event source

Third PR of the shell stack (`docs/notes/shell-plan.md`, section 4). It puts the layout of
`internal/layout` (PR 1) in the daemon: persisted, published and changeable. Nothing reads it
yet: the classic window ignores the new event kind, and the commands that change the layout are
PR 4's.

## What is in it

| File | Holds |
| --- | --- |
| `internal/db/migrations/0061_layout.sql` | `layout_spaces`, `layout_threads`, `layout_meta`, empty |
| `internal/db/layout_migration_test.go` | the migration on a database that already has threads |
| `internal/store/layout/layout.go` | `Store`, `Snapshot`, `Event`, `Delta`, `Diff`, `FocusOnly`, `Unchanged`, viewport |
| `internal/store/layout/store.go` | `Manager`: load and repair, `Apply`, the focus write-through, `Close` |
| `internal/store/layout/db.go` | reading the rows, writing what changed in one transaction |
| `internal/store/layout/layouttest` | the in-memory fake (real ops, `SeqIDs`, same events) |
| `proto/codefoundry/v1/layout.proto` | `LayoutService` (Get, Apply, SetViewport), the model, `LayoutEvent`, `LayoutOp` |
| `events.proto` | `EVENT_SOURCE_LAYOUT = 19`, `Event.layout = 22` |
| `internal/api/layout.go`, `layout_ops.go`, `layout_events.go` | the handler, the op converter registry, the event source |
| `internal/daemon` | the store opens after the database and closes before it; the route; `layout_e2e_test.go` |
| `internal/client` | `Client.Layout` |
| `gui/frontend/src/api/eventsUnknown.test.ts` | an unmapped or unknown event kind is dropped |

## Decisions

- **Migration number.** 0061 was still free on `shell` and on `main` when this was built. The SQL
  only creates empty tables, so it is safe on any existing database. If `main` takes 0061 before
  the shell merges, this file is renumbered then.
- **The default space** is stored in `layout_meta` (`default_space`), as PR 1's note asked, beside
  `rev` and `current_space`. A thread without a `layout_threads` row lives in it.
- **The current space is remembered** (shell-model.md, State): `current_space` in `layout_meta`.
  Switching space is focus-only, so it reaches the disk within a second or at shutdown;
  `TestReopensInTheCurrentSpace` and the daemon test pin it.
- **Load and repair.** Rows are read, each document decoded on its own (`DecodeSpaceDoc`,
  `DecodeThreadDoc`); one that does not decode (bad JSON, a newer `v`) becomes an empty space or an
  empty thread record, keeping its id, name and space. Then `Sanitize` runs once on the whole
  state. Any repair is logged at WARN with the list and the repaired state is written back at once
  (all rows rewritten in one transaction), so the next start logs nothing. A database error fails
  the start as for any store; a bad document never does. A new database (no row in any of the
  three tables) gets "Main" and an INFO line, not a warning.
- **One writer.** `Apply` holds one mutex: `core.Apply` on the current state, then write, swap the
  snapshot, publish. The event is published under the mutex, so the bus carries commits in rev
  order. An op that fails changes nothing; an op that changes nothing (`Unchanged`) is no commit:
  no rev, no event, `Commit.Changed` false.
- **What is written when.** The store keeps the state the tables hold (`disk`). A commit is
  focus-only when the states differ only in the current space, each space's focus and MRU, and each
  pane's active tab (`FocusOnly`, decided by comparing, not by op name, so PR 2's ops that only
  focus are throttled too). A structural commit writes the difference from `disk` before it is
  published (pending focus included); if the write fails, the op fails and nothing changed. A
  focus-only commit is published at once and written by a timer one second later, or by the next
  structural commit, or by `Close`. After a crash the stored rev can be lower than one a client
  saw; the restart changes the epoch, so every client takes the snapshot again.
- **Rev** is stored and survives restarts: 1, 2, 3 for the life of the database. A new database is
  at rev 0.
- **The event shape** follows plan 2.4, kept small: `LayoutEvent{rev, snapshot | delta, client_id}`.
  The delta carries whole changed spaces and whole thread records, and always the space order, the
  current space and the default space, so a client never needs "unchanged" rules. Left out for now,
  each a compatible addition later: the focus request (field 4 kept for it, PR 4 or 11 decides when
  an op asks), `ImportLegacy` and `legacy_imported` (PR 18), and the response's `rule` (PR 2's
  placement). `Layout.default_space_id` was added to the plan's shape: PR 1 made the default space
  a stored fact, and the sidebar needs it to place threads without a record.
- **Skipping old deltas.** The event hub joins a stream before it reads the snapshot, so a delta
  committed in between arrives after a snapshot that already has it. Its rev is not above the
  snapshot's, and the client skips it (documented on `LayoutEvent`; the GUI slice is PR 10).
- **Message names** carry `Layout` (`LayoutSpace`, `LayoutTab`, ...) and ops end in `Op`
  (`AddTabOp`): the package is shared by every service, and `Tab` or `Space` alone would be easy to
  collide with later. `NewSpaceOp.make_current` is the Go op's `Switch` (`switch` is a keyword in
  the generated TypeScript).
- **Ops through a registry.** `layout_ops.go` maps a `LayoutOp` case, by its field name, to a
  converter that builds the `internal/layout` op of the same JSON name; the names line up by
  construction, and `TestLayoutOpCasesConvert` checks every case and every op of `core.OpNames()`.
  The thread ops (`open_thread`, `close_thread`, `open_surface`, `move_thread`) are declared in
  the proto with the fields the plan and spec imply, and have no converter: they answer
  Unimplemented. The PR that wires PR 2's ops adds `layout_ops_thread.go` with `registerLayoutOp`
  calls (and may adjust those messages; nothing has been released). A case from a newer client
  arrives as an unknown field and also answers Unimplemented; an empty op is InvalidArgument.
  Nothing in PR 1's files changed.
- **Errors** map one to one: not found, invalid argument, already exists, failed precondition;
  `ErrClosed` is Unavailable; `ErrBroken` and anything else Internal.
- **Viewport.** `SetViewport` keeps the last size reported (validated: positive, under 1e6);
  before any, 1180 x 820. Preferring a visible window's report over a hidden one's needs presence
  and waits for the placement wiring that reads it.
- **Shared data.** Snapshots, deltas and the protos built from them share slices and maps with
  the store's state; nothing mutates a state once committed (`core.Apply` works on a copy), and
  the fake does the same.
- The plan said `internal/daemon/stores.go` would wire the store with thread and terminal glue;
  only the store is wired here (the glue is PR 6).

## Version window

- An older GUI with this daemon: field 22 of `Event` is unknown to it, `event.case` is undefined
  and `toEventView` returns null. `eventsUnknown.test.ts` pins both that and that this GUI drops
  the layout case, which it does not map yet.
- This GUI with an older daemon: no layout source; nothing reads it yet.
- `code-foundry events --source layout` works with no CLI change (the names come from the enum).

## Verification

- `make check` green.
- Store tests: a new database, persist and reload, one event per commit (no event for a no-op or a
  refusal), deltas applied in order rebuild the snapshot, focus written later (by the timer, by
  the next structural commit, by `Close`), the timer itself, corrupt rows of five kinds repaired
  and written back, concurrent applies with gapless revs in bus order, the viewport, reopening in
  the current space. `Diff`, `FocusOnly` and `Unchanged` are table-tested. The fake has its own
  test.
- API tests over the fake: Apply and Get, every error code, Unimplemented for a thread op and for
  an unknown case, the converter contract, the event source's snapshot and deltas with and
  without a client id.
- Migration test: 0061 on a database with threads and projects, twice.
- Daemon test (`TestLayoutEndToEnd`): a real daemon, the layout source, an op through the
  service as a delta, a focus-only switch, a restart, the same layout and current space.

### End to end with the built binary

`make build`, then a daemon on a scratch home (`CODE_FOUNDRY_HOME=$(mktemp -d /tmp/cf-l3.XXXX)`,
removed afterwards). No CLI verb changes the layout yet (PR 4), so the ops went through Connect's
JSON protocol with curl over the daemon's Unix socket.

```
$ code-foundry events --source layout
- layout snapshot
$ code-foundry events --source layout --json
{"layout":{"snapshot":{"spaces":[{"id":"sp-4eyxzpcv", "name":"Main"}], "currentSpaceId":"sp-4eyxzpcv", "defaultSpaceId":"sp-4eyxzpcv"}}, "epoch":"8074023a45ed"}
$ curl --unix-socket $HOME/daemon.sock .../LayoutService/Apply -d '{"op":{"newSpace":{"name":"Review"}},"clientId":"e2e"}'
{"rev":"1", "spaceId":"sp-gg7rh42h"}
$ curl --unix-socket $HOME/daemon.sock .../LayoutService/Apply -d '{"op":{"addTab":{"tab":{"kind":"prs"},"focus":true}},"clientId":"e2e"}'
{"rev":"2", "spaceId":"sp-4eyxzpcv", "paneId":"p-ii47ovf3", "tabId":"t-lmfrf7i6"}
$ curl --unix-socket $HOME/daemon.sock .../LayoutService/Apply -d '{"op":{"openThread":{"threadId":"s-1"}}}'
{"code":"unimplemented","message":"layout op open_thread is not available yet"}
$ curl --unix-socket $HOME/daemon.sock .../LayoutService/Apply -d '{"op":{"closeTab":{"tabId":"t-gone"}}}'
{"code":"not_found","message":"layout close_tab: tab \"t-gone\": not found"}
$ cat events.txt
- layout snapshot
3 layout delta
4 layout delta
$ cat events.json
{"layout":{"snapshot":{...as above...}}, "epoch":"8074023a45ed"}
{"layout":{"rev":"1", "delta":{"spaces":[{"id":"sp-gg7rh42h", "name":"Review"}], "spaceOrder":["sp-4eyxzpcv", "sp-gg7rh42h"], "currentSpaceId":"sp-4eyxzpcv", "defaultSpaceId":"sp-4eyxzpcv"}, "clientId":"e2e"}, "seq":"3", "epoch":"8074023a45ed"}
{"layout":{"rev":"2", "delta":{"spaces":[{"id":"sp-4eyxzpcv", "name":"Main", "root":{"pane":{"id":"p-ii47ovf3", "tabs":[{"id":"t-lmfrf7i6", "kind":"prs", "key":"prs"}], "activeTabId":"t-lmfrf7i6"}}, "focusPaneId":"p-ii47ovf3", "mruTabIds":["t-lmfrf7i6"]}], "spaceOrder":["sp-4eyxzpcv", "sp-gg7rh42h"], "currentSpaceId":"sp-4eyxzpcv", "defaultSpaceId":"sp-4eyxzpcv"}, "clientId":"e2e"}, "seq":"4", "epoch":"8074023a45ed"}
$ curl ... Apply -d '{"op":{"switchSpace":{"spaceId":"sp-gg7rh42h"}}}'
{"rev":"3", "spaceId":"sp-gg7rh42h"}
$ sqlite3 db.sqlite "select key, value from layout_meta"   # focus-only: not written yet
current_space|sp-4eyxzpcv
default_space|sp-4eyxzpcv
rev|2
$ kill <daemon pid>
$ sqlite3 db.sqlite "select key, value from layout_meta"
current_space|sp-gg7rh42h
default_space|sp-4eyxzpcv
rev|3
$ code-foundry daemon &   # restart
$ code-foundry events --source layout --json
{"layout":{"rev":"3", "snapshot":{"rev":"3", "spaces":[{"id":"sp-4eyxzpcv", "name":"Main", "root":{"pane":{"id":"p-ii47ovf3", "tabs":[{"id":"t-lmfrf7i6", "kind":"prs", "key":"prs"}], "activeTabId":"t-lmfrf7i6"}}, "focusPaneId":"p-ii47ovf3", "mruTabIds":["t-lmfrf7i6"]}, {"id":"sp-gg7rh42h", "name":"Review"}], "currentSpaceId":"sp-gg7rh42h", "defaultSpaceId":"sp-4eyxzpcv"}}, "epoch":"870eeeb46cc8"}
$ kill <daemon pid>; sqlite3 db.sqlite "update layout_spaces set doc = '{not json' where name = 'Main'"
$ code-foundry daemon &
$ grep layout logs/daemon.log | tail -1
{"level":"WARN","msg":"layout: repaired the stored layout","store":"layout","repairs":["space sp-4eyxzpcv: decode space sp-4eyxzpcv: invalid character 'n' looking for beginning of object key string: invalid argument; its panes are dropped"]}
$ curl ... LayoutService/Get -d {}
{"layout":{"rev":"3", "spaces":[{"id":"sp-4eyxzpcv", "name":"Main"}, {"id":"sp-gg7rh42h", "name":"Review"}], "currentSpaceId":"sp-gg7rh42h", "defaultSpaceId":"sp-4eyxzpcv"}}
```

The snapshot at rev 0 prints no `rev` (protojson leaves out zero values). The live seqs start at 3
because the hub numbers every source's events.

## Gotchas

- `go build ./...` from the repository root needs the GUI's `frontend/dist` (`make check` makes a
  stub) and the libghostty-vt `PKG_CONFIG_PATH` the Makefile exports; outside make, build
  `./internal/... ./cmd/...` with that path set.
- `reflect.DeepEqual` tells a nil thread map from an empty one, which `core.Apply`'s copy can
  produce; `Unchanged` compares the maps with `maps.EqualFunc` so that is no commit.
- Tests use `core.SeqIDs`, and a new database's first space is made by `Sanitize` with those ids:
  it is `sp-n1`, so the first `new_space` is `sp-n2`.

## For later PRs

- **PR 2 / 4**: register converters for the thread ops in a new `internal/api/layout_ops_thread.go`;
  placement reads `Store.Viewport()`. Add `rule` to `ApplyLayoutResponse` if the CLI wants it.
- **PR 4**: commands take `layout.Store` (`layouttest.Fake` in their tests). A command from inside
  a thread passes no client id.
- **PR 6**: the thread and terminal glue applies ops with an empty client id.
- **PR 10**: the GUI slice skips a delta whose rev is not above its own, and replaces its state on
  a snapshot.
- **PR 18**: `ImportLegacy` and `legacy_import` in `layout_meta`.
- **PR 23**: `docs/ARCHITECTURE.md` gets `store/layout` and `LayoutService`.
