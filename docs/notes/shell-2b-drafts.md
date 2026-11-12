# Shell PR 2b: composer drafts

A small layout PR after PR 2 (`docs/notes/shell-model.md`, "Build"). It adds the spec's composer
drafts to `internal/layout` as pure ops: the empty composer and drafts as two kinds of compose tab,
each space's list of drafts, and the ops on them. Nothing is wired to the daemon, the CLI or the
GUI. The specification is the "The composer" bullet of `shell-model.md` and its sub-bullets.

## What is in it

| File | Holds |
| --- | --- |
| `drafts.go` | `Draft`'s helpers, `followDrafts` (run by `finish`), and the ops `new_thread`, `start_draft`, `label_draft`, `clear_draft`, `discard_draft`, `open_draft` |
| `model.go` | `Space.Drafts` and the `Draft` type `{id, label, params}` |
| `identity.go` | the composer's key: `compose` for the empty one, `compose:draft:<id>` for a draft |
| `op.go`, `ops_tree.go`, `ops_space.go`, `thread.go` | the guards and the draft side of `prepare`, `set_tab_params`, `remove_space` and `open_thread` |
| `check.go`, `decode.go` | the draft rules of normal form, their repair, and `SpaceDoc.Drafts` |
| `testdata/ops/*.json` | 36 new cases (162 in all) |

## The model as built

- **A compose tab is EMPTY or a DRAFT.** A draft is a compose tab whose param `draft` holds its
  id; its key is `compose:draft:<id>`. The empty composer has no such param and keeps the key
  `compose`, so the existing one-per-space identity rule still gives "at most one empty composer
  per space" and a space can hold any number of drafts.
- **Each space lists its drafts** (`Space.Drafts`, stored in `SpaceDoc.drafts`): id, label, and the
  tab's other params, newest first, whether or not each has a tab open. The empty composer is never
  listed. Normal form: a draft id is listed once in the whole state; a draft's tab is open at most
  once, and only in the space that lists it; an open draft's entry holds its tab's params.
- **The draft's text is not in the layout.** Only its id, its label and the tab's params are, so
  typing does not write the layout on each keystroke. The text lives wherever the GUI PRs put it,
  keyed by the draft id (see "For later PRs").
- **`followDrafts`** runs at the end of every op (`finish`): a draft whose tab is now open in another
  space than the one listing it moves to the top of that space's list (its tab was dragged there),
  and each entry takes its open tab's params. So no tree op needs to know about drafts.

## The ops

| Op | JSON | Does |
| --- | --- | --- |
| New thread | `{"op":"new_thread","space"?,"pane"?,"params"?,"focus"?}` | Focuses the space's empty composer when it has one (with `params` when given), else opens one in the focused pane after its active tab, or as the first pane of an empty space. With `pane` (a pane's "+") it opens there, and an empty composer open elsewhere in the space moves there. It is `open_surface` with a compose tab; a `draft` param is refused. |
| Start a draft | `{"op":"start_draft","tab","draft"?,"label"?}` | The first text typed: the empty composer `tab` becomes a draft with id `draft` (refused when used anywhere in the layout) or a new `d-` id, listed first. `Result.draft` is the id. |
| Relabel | `{"op":"label_draft","draft","label"}` | Sets the label, open or closed. |
| Clear | `{"op":"clear_draft","draft"}` | All text deleted: the draft leaves the list and its tab is the space's empty composer again, with its params. When the space already has an empty composer, the one of the two without the focus closes (`Result.closed`); when neither has it, the draft's tab closes. A draft whose tab is closed is just dropped. |
| Discard | `{"op":"discard_draft","draft"}` | The sidebar row's discard: leaves the list, and its tab, when open, closes; focus returns as `close_tab`'s. |
| Reopen | `{"op":"open_draft","draft","focus"?}` | The sidebar row's click: focuses the draft's tab where it is, or opens it in its space's focused pane after the active tab, with the params it had. |

Through the existing ops:

- **Closing a draft's tab** (`close_tab`, `close_pane`) keeps the draft in the list.
- **Sending** (`open_thread` with `compose` naming a draft's tab) turns that tab into the thread's
  tab, removes the draft from the list and reports its id in `Result.draft`.
- **The ephemeral rule** of `open_thread` replaces only an EMPTY composer that is the only tab in its
  space; a lone draft stays and the thread opens after it.
- **A draft's tab dragged to another space** (`move_tab`, `move_pane`) takes the draft along.
- **`remove_space`** closes the space's draft tabs with everything else and moves its drafts to the
  top of the target's list, closed.
- **`add_tab`, `split_pane`, `open_surface`** accept a compose tab with a `draft` param only in the
  space that lists that draft (`not_found` when none does, `failed_precondition` when another does).
- **`set_tab_params`** on a draft's tab keeps its `draft` param when the new params leave it out;
  changing it, or giving one to the empty composer, is refused (`invalid_argument`).

## Decisions to confirm

1. **The draft id is a tab param**, not a field of `Tab`: the identity table already reads params,
   and the GUI's registry keys tabs the same way.
2. **The list is newest first**, and a draft that arrives in a space (dragged there, or from a
   removed space) goes to the top. The spec only says the drafts are listed at the top of Active.
3. **An entry keeps the tab's other params** (project, workspace, like), not only id and label, so a
   draft whose tab was closed reopens on the same project. They change rarely, so this costs no
   event per keystroke.
4. **Labels** are one line, whitespace collapsed, at most 80 runes. An empty label is allowed; the
   GUI draws a placeholder for it.
5. **`start_draft` takes a client-chosen id**, so the GUI can store the first text under the id
   before the reply comes back. It must be unused anywhere in the layout.
6. **Clearing when neither composer has the focus** closes the draft's tab (the spec covers only the
   case where one of them has it). Clearing a closed draft drops it, as discarding does.
7. **A draft's tab may be dragged to another space** and its draft follows. Thread tabs are refused
   there because moving a thread is its own op; a draft has nothing else to carry.
8. **Removing a space keeps its drafts** in the target space. The spec drops its tabs and panes, and
   says drafts survive; a draft is the user's unsent text.
9. **`open_draft` takes no pane**: the sidebar row opens it in the focused pane, as the spec says. A
   pane's "+" offers New thread, not drafts.

## Gotchas

- A compose tab with a `draft` param that no space lists would pass every tree op and then fail
  `Check` (`ErrBroken`). `prepare` refuses it first, and the property run checks that no op slips
  through.
- `followDrafts` runs only on success: a failed op returns the state it was given, so a draft never
  half-moves. It does not list a draft that is listed nowhere; only the sanitizer does that.
- The sanitizer drops a second tab of one draft in the tab pass (before `norm`), so an emptied pane
  goes with it. It lists a draft that is open but listed nowhere rather than dropping its tab, so a
  half-written document loses no draft.

## Verification

- `make check` green.
- 36 new JSON cases, at least one per new op and one per edge above. `-update` wrote each `want` and
  `result`; every one was then read against the rule its `doc` names. The 126 earlier cases did not
  change.
- `TestDecodeDrafts`: documents written before this PR (no `drafts`, a composer with a project,
  and the pre-PR 2 keys `compose:home` and `compose:project:<id>`) decode with no draft repair; a
  broken draft list is repaired step by step. `TestCheckDrafts` breaks each draft rule of normal
  form once. `TestDraftLabel`, `TestSpaceDocDrafts` (round trip, clone, an old space document),
  `TestDraftOpsJSON`.
- Property run: the seed has an empty composer, random tabs may name a draft, and the six new ops
  are drawn like any other. After every step: normal form; at most one empty composer per space; a
  draft listed once and its tab, when open, the only one and in the space that lists it; a draft that
  `clear_draft`, `discard_draft` or `open_thread` ended is gone. In that run every path fires:
  sending from a draft, clearing into the empty composer, clearing that closes a tab, reopening,
  and a draft following its tab to another space.
- Fuzz, bounded, run by hand: `FuzzOps` for 60s (93k sequences) and `FuzzDecode` for 60s (18.5M
  executions), both clean.
- No end-to-end step: nothing is wired yet.

## For later PRs

- **PR 3** (store): `SpaceDoc` now has `drafts`; store it with the space row. Decoding a space
  document written before this PR gives no drafts and needs no repair. `Result.draft` should reach
  the response: after `clear_draft`, `discard_draft` and an `open_thread` that sent from a draft, the
  draft is gone and its stored text is deleted.
- **The draft's text** is stored outside the layout, keyed by draft id, and survives a restart (the
  spec). The GUI calls `start_draft` on the first text typed (it may pass its own id), `label_draft`
  throttled as the first line changes, and `clear_draft` when the text is emptied. Nothing here
  stores or deletes text.
- **PR 4** (commands): verbs for these ops. New thread (`cmd+n`) is `new_thread`, not
  `open_surface`; the "+" menu's New thread passes `pane`. The sidebar row needs `open_draft` and
  `discard_draft`; the composer needs `start_draft`, `label_draft` and `clear_draft`, which are not
  in the palette.
- **The sidebar PR** lists the current space's drafts (`Space.Drafts`, in order) at the top of
  Active, below the pinned threads, drawn so they read as drafts, with the label (a placeholder when
  empty). A click is `open_draft`; the row's discard is `discard_draft`. The empty composer is not
  listed.
- **The GUI's composer** finds its draft by the tab's `draft` param and its label in the space's
  list; the tab's title stays empty.
