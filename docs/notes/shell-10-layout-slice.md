# Shell PR 10: the layout slice, its API mapping and the mock daemon's layout

Tenth PR of the shell stack (`docs/notes/shell-plan.md`, section 4). The GUI can now hold the
daemon's layout and change it, and the mock daemon serves a layout of its own. Nothing draws it
yet (PR 11), and with the shell flag off nothing reads it.

## What is in it

| File | Holds |
| --- | --- |
| `src/api/layout.ts` | the only user of the generated layout types: view models (a space's drafts included), `toLayoutEventView`, `LayoutOpView` (every op of `LayoutOp`, in internal/layout's JSON form) and `toLayoutOpMessage`, `getLayout`, `applyLayoutOp` (with the response's rule, kept, ended, restored, swapped and draft), `setLayoutViewport` |
| `src/api/events.ts` | the `layout` source in `EventView`; `currentClientId()` (the open stream's id) |
| `src/stores/layout.ts` | the slice: snapshot and deltas by rev, resync on a gap, identity kept, optimistic focus; `geoTree`, `usePane`, `useTab`, `useTree`, `useSpace`, `useSpaceOrder`, `useCurrentSpaceId`, `useThreadLayout`, `spaceOfThread` |
| `src/stores/events.ts` | one handler entry, which applies the source only with the flag on |
| `src/shell/flag.ts` | `shellOn()`: `localStorage["code-foundry.shell"] === "1"` or `?shell=1`, read once per load |
| `src/shell/viewport.ts` | `reportViewport(w, h)`: SetViewport, debounced 200 ms, in layout px; `resendViewport()` on each snapshot |
| `mock/layout.ts` | `MockLayout` (LayoutService, the source, seeds), a port of internal/layout's mechanical ops, drafts and `keep_focus`, the simplified thread ops, proto mapping both ways |
| `mock/server.ts`, `mock/world.ts` | the service route, the source's snapshot in `Watch`, `world.layout`, `GET`/`POST /__mock/layout` |

## The slice's shape

```ts
{ loaded, rev, spaceOrder, currentSpaceId, defaultSpaceId,
  spaces:  { [id]: { id, name, focus, mru, drafts } },   // drafts: [{ id, label, params }], newest first
  trees:   { [spaceId]: TreeNode | null },       // structure only: {t:"pane", id} | {t:"split", id, dir, kids, sizes}
  panes:   { [id]: { id, spaceId, tabIds, active } },
  tabs:    { [id]: LayoutTabView & { paneId } },
  threads: { [threadId]: ThreadLayoutView } }    // only threads with a record; others live in defaultSpaceId
```

- **Events.** A snapshot replaces everything, whatever its rev (a restarted daemon may be behind).
  A delta at or below the slice's rev was already in the snapshot it came after and is skipped.
  The next rev applies. A later one means events were missed. The slice then reads the whole
  layout with `Get`, holds the deltas that arrive meanwhile, and applies those above the `Get`'s
  rev in order.
- **Identity.** The slice keeps the layout the daemon confirmed, nested as the API maps it. Each
  change flattens it again and keeps the previous object for every space, tree, pane, tab and
  thread record that is deep-equal, and the previous record maps when none of their entries
  changed. A delta that switches one pane's active tab therefore re-renders only that pane's
  `usePane`; trees, tabs and the other panes stay the same objects (tested, and with
  `renderHook` render counts).
- **Optimistic focus.** `focusTab(id)` and `focusPane(id)` are the only changes applied before the
  daemon answers (plan 2.6). Each is a pending overlay on the confirmed layout, applied as Go's
  `focus_tab`/`focus_pane` without smart swap: the pane's active tab, the space's focus and MRU,
  and the current space. It stays on top until a commit at or above the rev `Apply` answered
  arrives, so an unrelated commit from before it does not undo it. Then the daemon's version
  stands, smart swap included. A refusal or a failed call drops it at once, and the call resolves
  `false`. Everything else (`applyLayout(op)`) waits for its event.
- **The flag.** With it off, the `layout` handler drops every event, so the slice stays empty and
  `loaded` false. The classic window is unchanged, and `reportViewport` sends nothing.
- **Client id.** `applyLayoutOp` and `setLayoutViewport` send the open event stream's client id, so
  a window can tell its own commits in the source.

## The mock daemon

- **Ported and pinned:** the tree and space ops (`add_tab`, `split_pane`, `move_tab`, `move_pane`,
  `merge_pane`, `swap_pane`, `close_tab`, `close_pane`, `set_sizes`, `focus_tab`, `focus_pane`,
  `set_tab_params`, `rename_tab`, `new_space`, `rename_space`, `remove_space`, `reorder_spaces`,
  `switch_space`), the draft ops (`new_thread`, `start_draft`, `label_draft`, `clear_draft`,
  `discard_draft`, `open_draft`), and `open_surface` for everything but rules 2 to 6. Also ported:
  the identity table (a draft is keyed by its id), drafts following their tabs (`followDrafts`),
  normal form, and the `keep_focus` option a call from inside a thread runs with.
  `mock/layout.test.ts` reads every case in `internal/layout/testdata/ops`. It runs 112 of the 165
  with the `SeqIDs` scheme and the case's options, and checks the state (keys left out, sizes to
  1e-9), the result (space, pane, tab, existing, closed, rule, draft), the error code, and that a
  refusal changes nothing. All 112 agree with Go.
- **Not run against the cases (53), each a rule tested in Go:**
  - the thread ops: `open_thread` with its restore, `close_thread`, `move_thread`,
    `archive_thread`, `snooze_thread`;
  - `open_surface` cases whose rule is 2 to 6 (a linked surface beside its open thread);
  - the two cases about a remembered set (`close_pane-closes-threads` remembers the linked tabs,
    `open_surface-drops-remembered` drops a remembered one);
  - the four cases whose result swaps a pane (`focus_tab-smart-swap`, `-last`, `-mru`,
    `close_tab-smart-swap-on-return`): smart swap is not ported.

  The test names each group, so a new case runs unless it is one of these.
- **Simplified thread ops** (plan 2.14), so later GUI PRs can open things against the mock:
  - `open_thread` focuses an open thread tab. Otherwise it takes the place of the composer it was
    sent from (`compose`, ending its draft), or of its space's empty composer when that is the
    space's only tab; else it opens in the focused pane (or the pane given).
  - A linked surface beside its open thread joins the pane holding the thread's linked tabs (after
    the last of them), else a new pane right of the thread's at 0.45 (`rule: "mock"`).
  - `close_thread` closes the thread's tab and its linked tabs in its space and remembers nothing,
    and so does `close_pane` for each thread tab in it.
  - `move_thread`, `archive_thread` and `snooze_thread` answer Unimplemented.
- **Commits.** A change is one commit with the next rev and one delta (whole changed spaces and
  thread records, the order, current and default space always). A no-op is no commit. "Changed"
  compares states with Go's empty fields left out (`canon`). `reset()` goes back to one empty
  space without lowering the rev, because a connected GUI holds one.
- **Seeds:** `POST /__mock/layout?seed=empty|one-thread|thread-and-diff|grid|spaces`, or a whole
  state (internal/layout's JSON) as the body for any other tree. `GET /__mock/layout` gives the
  rev, the state, the last viewport and every Apply with its client id. The seed tabs' params follow
  the layout identity table; PR 11 may change them to what its surfaces read.

## Decisions

- **Ops in the GUI are internal/layout's JSON** (`{op: "move_tab", tab, pane, edge, ...}`), not
  the proto's camel case. They are the same shape as the shared cases and the mock's ops, and
  `toLayoutOpMessage` maps them. The test round-trips them through the proto into the mock's
  `opFromProto`.
- **The API's tree is the geometry's.** `LayoutNodeView` has PR 1's JSON shape (`t`, `id`, `tabs`,
  `active`, `dir`, `kids`, `sizes`), so a space's root is a `GeoNode` as it stands. The slice keeps
  trees without tabs (plan 2.13), and `geoTree(state, spaceId)` puts the tabs back for the
  geometry.
- **Defensive mapping.** A pane without tabs or a split without kids maps to nothing, a one-kid
  split to its kid, and an unset active tab to the first. Normal form never sends these, but an
  unknown direction or edge from a newer daemon cannot crash the window.
- **`eventsUnknown.test.ts`** pinned that this GUI dropped the layout source. It now pins that a
  layout event with a change kind this build does not know is dropped.
- **Rebased onto PR 4 and the drafts PR** before review. Their op changes reached the mock (drafts,
  `keep_focus`, `close_pane` closing threads, `open_surface`'s space) and the API (the space's
  drafts, the response's new fields, the new op cases). The slice needed only `drafts` on a space.
- **Viewport.** One reporter with the last size, debounced 200 ms. It skips a size it already sent,
  tries again after a failed send, and sends again on every snapshot (a reconnect, or a daemon
  that restarted and forgot the size). The pane grid calls `reportViewport` with its box in
  viewport px; the zoom is divided out here.

## Verification

- `make check` green. `make gui-e2e` with the flag off, on the rebased tree: 522 passed, 141
  skipped, none failed. Before the rebase, two specs that do not read the layout failed once under
  the full suite's load and passed when run again: `thread-find.spec.ts:124` and the 90% case of
  `zoom-popovers.spec.ts:24`. One `make check` also timed out once in
  `components/plugin/tablenode.test.tsx` and passed on its rerun.
- vitest: `stores/layout.test.ts` covers a snapshot, a delta keeping identity (and hook render
  counts), removals, skipping old deltas, the resync after a gap with deltas held, a lower-rev
  snapshot, `geoTree`, optimistic focus across spaces, focus kept over an earlier commit and then
  the daemon's (smart-swapped) word, correction by a different commit, revert on refusal, and a
  no-op answer. `api/layout.test.ts` covers snapshot and delta mapping off the wire, ops to proto
  and into the mock. `shell/flag.test.ts` covers the flag table, reading once, and the handler
  gated on the flag. `shell/viewport.test.ts` covers debounce, zoom, repeats, resend, failure and
  off. `mock/layout.test.ts` runs the Go cases and checks the mock's commits, deltas, refusals,
  seeds and simplified thread ops.
- End to end against the mock (`make drive`, `?shell=1`): the slice loads the snapshot, a
  `POST /__mock/layout?seed=grid` arrives as one delta, and `focusTab` shows at once and comes back
  confirmed. The mock recorded the Apply with the stream's client id. Without `?shell=1`, `loaded`
  stays false.
- End to end against a real daemon (`make drive DAEMON=dev`, scratch home under /tmp, removed
  afterwards):

```
$ code-foundry events --source layout --json   # rev, kind, client id, one line per event
0 snapshot
1 delta 4f009e668030dc119f5b4c99               # add_tab prs, from the GUI's applyLayout
2 delta 4f009e668030dc119f5b4c99               # split_pane projects
3 delta 4f009e668030dc119f5b4c99               # focusPane, optimistic, then confirmed
4 delta cli-test                               # rename_space by another client over curl
```

  In the GUI: the tree was `row(p-…, p-…)` at sizes 0.6/0.4, the untouched pane kept its object
  across the focus commit, and the rename showed at rev 4. SetViewport answered 200.

  After the rebase, on a daemon with PR 4 and drafts: `new_thread` with `{project: "pj"}`, then
  `start_draft` on its tab with the label `"  Fix   the\nbuild  "`, then `new_thread` again. The
  slice's space held
  `drafts: [{id: "d-xa4hn62d", label: "Fix the build", params: {project: "pj"}}]`, and the focused
  pane held the draft tab (`{project, draft}`) and a new empty composer. Both opens answered
  `rule: "focused"`.

## Gotchas

- The mock's `norm` must not replace a pane's tab array: an op (`move_tab` into another pane)
  holds it across a removal that normalises the tree, as Go's `DeleteFunc` works in place. A shared
  case (`move_tab-empties-pane`) caught it.
- A mock test that reads repo files with `node:fs` needs `// @vitest-environment node` (jsdom's
  `URL` is not `file:`), and `import.meta.glob` is untyped under `tsconfig.node.json`.
- A daemon home under the scratchpad makes a socket path over macOS's 103 bytes: `make drive
  DAEMON=dev` without `DRIVE_HOME` uses a short /tmp directory.

## For later PRs

- **PR 11** (pane grid): read `useTree(currentSpaceId)` and `usePane`/`useTab` per pane; draw with
  `shellFrame(geoTree(...))`; call `reportViewport` from the grid's resize observer; focus a pane
  on click with `focusPane` (or route through `pane.focus` once PR 4's commands exist, keeping the
  optimistic overlay: `focusTab`/`focusPane` take the op, so a command path needs a rev back to
  drop it). Before the flag can show the shell, wait for `loaded`; with no layout snapshot (an
  older daemon), stay classic and say so once (plan 2.12).
- **PR 11 / mock commands**: PR 4's verbs (`space.*`, `pane.*`, `tab.*`, `thread.open`,
  `composer.new`, `composer.draft.*`) have no mock entries yet. PR 11 adds them, each calling
  `world.layout.apply(op, "", { keep_focus })` with the op its Go command runs. No command names
  were invented here.
- **The composer PR**: the slice has each space's drafts; the draft ops are in `LayoutOpView` and the
  mock. The draft's text is stored elsewhere, keyed by the draft id (drafts note).
- **PR 11**: seed tabs' params (`thread-and-diff`, `grid`) may need the params the diff and other
  surfaces read; seed what e2e needs with `POST /__mock/layout` and a body.
- **Smart swap in the mock**: not ported. A browser test that needs a swapped pane seeds it.
- **The focus request** (`LayoutEvent` field 4) is not in the proto yet. When it lands, map it in
  `toLayoutEventView` and hand it to the shell's DOM focus, not to the slice.
