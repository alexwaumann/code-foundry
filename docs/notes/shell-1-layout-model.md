# Shell PR 1: the layout model, tree operations and plain rectangles

First PR of the shell stack (`docs/notes/shell-plan.md`, section 4). It adds the pure Go package
`internal/layout`: the model, decode and repair, every tree and space operation, the plain
proportional rectangles, and the surface identity table, with the JSON test cases later PRs
reuse. Nothing is wired to the daemon, the CLI or the GUI.

## What is in it

| File | Holds |
| --- | --- |
| `model.go` | `State`, `Space`, `Node` (pane or split), `Tab`, `ThreadState` and its remembered set, finders, `Clone` |
| `tree.go` | `norm` (normal form), `removeNode`, `insertBeside`, `detach`, `Lca`, `BesideInfo` (ports of the toy's functions) |
| `identity.go` | the kind table (link, scope, key, renameable, default size) and `Identify` |
| `op.go` | the `Op` interface, the op registry, `Apply`, id makers, the focus helpers |
| `ops_tree.go` | `add_tab`, `split_pane`, `move_tab`, `move_pane`, `merge_pane`, `swap_pane`, `close_tab`, `close_pane`, `set_sizes`, `focus_tab`, `focus_pane`, `set_tab_params`, `rename_tab` |
| `ops_space.go` | `new_space`, `rename_space`, `remove_space`, `reorder_spaces`, `switch_space` |
| `check.go` | `Check`: the strict normal-form check |
| `decode.go` | `Encode`/`Decode` of a whole state, `Sanitize` (repair), the per-row `SpaceDoc` and `ThreadDoc` |
| `rects.go` | `Rects` (plain layout, no minimums, no rails), `SideNeighbours`, `Adjacent` |
| `testdata/ops/*.json` | 60 op cases, at least one per op (a test enforces it) |
| `testdata/rects.json` | 7 layout cases with rectangles, gutters, neighbours and adjacency |
| `testdata/kinds.json` | the identity table, for the GUI registry's drift test |

## Decisions

- **One `Node` struct** for panes and splits, with the JSON shape of plan 2.3 (`t`, `id`, `tabs`,
  `active`, `dir`, `kids`, `sizes`). It keeps the JSON flat for the GUI and the mock.
- **Ops are values.** Each op is a struct registered by its JSON name in an `init` of its file;
  its JSON form is `{"op": "<name>", ...fields}`, decoded with unknown fields refused. `Apply`
  runs the op on a deep copy, normalises, then runs `Check`; on any error it returns the state it
  was given, untouched. An op that would leave the state out of normal form fails with
  `ErrBroken` instead of being stored.
- **Errors** are `ErrNotFound`, `ErrInvalidArgument`, `ErrAlreadyExists`, `ErrFailedPrecondition`
  (plus `ErrNewerVersion` and `ErrBroken`), wrapped with `%w`, so the handler maps them to Connect
  codes one to one.
- **The default space.** The plan has a thread without a row belong to "the first space by
  position". That breaks when the first space is removed and its threads should go to some other
  space than the new first one. `State.DefaultSpace` names that space instead; removing it makes
  the removal's target the default, so threads without a row follow.
- **The focus rule of plan 2.6** is in `add_tab` and `split_pane` as `focus`: with it the tab takes
  the focus (and its space becomes current); without it the tab becomes active in its pane unless
  that pane is the focused one, where it waits behind the active tab. Moves, merges and
  `focus_*` always focus what moved. `focus_tab` and `focus_pane` switch to the space; a move to
  another space does not.
- **Identity in the tree ops.** `add_tab` with an identity already open in its scope uses the
  open tab (replacing its params and title when given) and reports `existing`; `split_pane`
  refuses it (`already_exists`: move that tab instead); `move_tab`, `move_pane` to another space
  and `set_tab_params` refuse a collision.
- **Threads in the tree ops.** A thread tab is added only in its thread's space, and `move_tab` and
  `move_pane` never carry a thread tab to another space (`failed_precondition`): moving a thread
  takes its linked tabs and is PR 2's op.
- **Closing is plain here.** `close_tab` and `close_pane` remove tabs and give the focus back to the
  newest MRU entry still open in the space ("focus returns to what had it before"); with none, the
  tab or pane now at the closed one's place. `Result.Closed` lists what went, so the caller ends
  unlinked terminals and closes threads.
- **Removing a space** (spec: always drops its tabs and panes; a dialog moves or archives its
  threads): `remove_space` drops everything in it into `Result.Closed`, moves its threads to `to`
  (default: the space on its left, else on its right) with no remembered set and no `last`, and
  refuses the last space. Archiving instead is the thread store's, before or after the op.
- **Identity table** (plan 2.7), with these choices:
  - kind names are the plan's: `file` and `ember.board` (today's GUI says `files` and `ember`);
  - `compose` keys name the param: `compose:project:<id>`, `compose:workspace:<id>`,
    `compose:like:<thread>`, `compose:home`, so a project id and a workspace id cannot collide;
  - `pullrequest` takes today's params `slug` and `number`; the number must be a canonical positive
    integer;
  - only `terminal` is renameable as a tab (a thread is renamed in the thread store); a manual name
    on another kind is dropped;
  - default sizes from the toy's `kindSize`: diff and pull request 0.45 with a 480px floor, file
    0.35, terminal 0.3, pages and compose 0.5; mcp and plugin 0.35, gallery 0.45 (my choice).
    Placement (PR 2) owns how they are applied.
- **Rectangles.** `Rects` is the plain branch of the toy's `lay`: each split shares its length
  minus its gutters (12px) by its sizes, edges are rounded with JavaScript's `Math.round`
  (`floor(x + 0.5)`) so the GUI's port gives the same pixels, and the last child runs to the far
  edge, so a fractional area (page zoom) still tiles exactly. `SideNeighbours` sorts by shared edge
  length, then by id (the toy relied on object key order).
- **Ids** are the prefix (`sp-`, `p-`, `s-`, `t-`) and 8 random base32 characters; `Apply` retries
  one already used anywhere in the state, remembered panes included.
- **Normal form keeps stored sizes bit for bit**: `norm` rescales a split only when its sizes are
  more than 1e-12 from summing to 1, so decoding a stored tree reports no repair.

## The JSON case format (a contract for PRs 2, 9 and 10)

**Op cases**, one file each, `testdata/ops/<op>-<what>.json`:

```jsonc
{
  "doc": "one sentence: the rule the case pins",
  "state": { /* a whole State */ },
  "op": { "op": "move_tab", "tab": "t-f", "pane": "p-a", "edge": "bottom", "frac": 0.3 },
  "want": { /* the State after the op */ },          // or, for a refusal:
  "error": "not_found" | "invalid_argument" | "already_exists" | "failed_precondition",
  "result": { "space": "…", "pane": "…", "tab": "…", "existing": true, "closed": ["t-…"] }
}
```

- A `State` is `{"v": 1, "spaces": [Space], "current_space", "default_space", "threads"?}`; a
  `Space` is `{"id", "name", "root": Node | null, "focus"?, "mru"?}`; nodes and tabs as plan 2.3.
- Tab `key` is left out: it is derived from kind, thread and params when the state is read.
- `state` and `want` are in normal form: they must decode with no repair.
- New ids come from `SeqIDs`: a counter per prefix starting at 1, so the first new pane is `p-n1`,
  the first new split `s-n1`, the first new tab `t-n1`, the first new space `sp-n1`. A port of the
  runner uses the same scheme, fresh for each case.
- Sizes are compared rounded to 1e-9. A refusal must leave the state unchanged. `result` is
  compared field by field when present (closed tabs by id).

**Rect cases**, `testdata/rects.json`, an array of
`{"doc", "root", "w", "h", "rects": {pane: {x, y, w, h}}, "gutters": [{split, i, row, x, y, w, h}],
"neighbours": {pane: {side: [pane]}}, "adjacent": [[a, b]]}`; only panes with a neighbour on a
side are listed, and `adjacent` lists the adjacent pairs in layout order. Rectangles are exact.

**Kinds**, `testdata/kinds.json`: the identity table as `Kinds()` writes it.

`go test ./internal/layout -update` rewrites the expected parts (`want`, `error`, `result`, the
rect outputs, `kinds.json`) from the code and formats them (a value that fits in 100 columns
stays on one line). Every expected state in this PR was written that way and then read case by
case against the rule its `doc` names; read the diff of any rewrite the same way.

## Verification

- `make check` green.
- Table tests per op (the JSON cases), identity keys per kind and the spec's identity rules
  through `add_tab`, `norm`, `Lca`, `BesideInfo`, remove-then-put-back restoring sizes, decode
  repairs and refusals, the per-row documents and op JSON round trips. Coverage 91.5%.
- Property test: 400 random sequences of up to 60 ops from a two-space seed; after every step the
  state is in normal form, a failed op changed nothing, the input was not mutated, closed tabs are
  gone, and the result encodes and decodes back unchanged with no repair.
- Rects: every case and 500 random trees tile their area exactly (no gaps, no overlaps, 12px
  gutters).
- Fuzz, bounded, run by hand: `go test ./internal/layout -run '^$' -fuzz '^FuzzDecode$' -fuzztime 60s`
  (3.6M executions) and the same for `FuzzOps` (167k sequences), both clean. `make check` runs
  only their seed corpora.
- No end-to-end step: nothing is wired yet.

## Gotchas

- An op struct cannot have a field `Name` and a method `Name()`; the interface method is `OpName`.
- `Sanitize` runs on states that are not yet repaired, so everything it calls (`usedIDs` for new
  ids) must skip nil spaces, tabs and thread states. The decode fuzz seed found that on its first run.
- Fixtures that leave `key` out must not count as repaired: `Sanitize` fills an empty key silently
  and notes only a wrong one, and notes "normal form" only for a change `norm` itself made.

## For later PRs

- **PR 2**: closing a thread tab (`cmd+w`, `close_pane` on a pane with threads) must go through
  `CloseThread`, which remembers the linked set; the plain `close_tab` does not. Moving a thread, or
  a pane that holds one, to another space is refused here and belongs to `MoveThreadToSpace`. The
  spec's "+" menu opens a page that is already open elsewhere in the space in the chosen pane;
  `add_tab` focuses it where it is, so placement moves it. Restore uses `BesideInfo` and `Lca`;
  placement uses `Kind.DefaultFrac`/`FloorPx`, `Layout.SideNeighbours` and `Layout.Adjacent`;
  smart swap uses `ThreadState.Last`.
- **PR 3**: store `DefaultSpace` in `layout_meta` (`default_space`), not "first by position"; read
  rows with `DecodeSpaceDoc`/`DecodeThreadDoc`, assemble a `State`, run `Sanitize` once and log its
  repairs with slog. Focus-only ops for the write throttle: `focus_tab`, `focus_pane`,
  `switch_space`. The proto `LayoutOp` cases map onto these structs; `ApplyLayoutResponse` takes
  `Result`.
- **PR 4**: focusing or moving a pane by direction (`ctrl+cmd+h/j/k/l`) needs the toy's
  `neighbour(dir)` over a `Layout`, not built here; moving by direction is then `swap_pane`.
- **PRs 9 and 10**: the GUI geometry and the mock read `testdata/rects.json` and `testdata/ops`,
  with `Math.round` parity and the `SeqIDs` scheme above; the GUI registry reads `testdata/kinds.json`.
- **PR 18**: the legacy import maps today's kinds `files` to `file` and `ember` to `ember.board`.
- `ThreadState.Quick` and the remembered set are modelled, decoded and repaired, but no op of this
  PR writes them.
