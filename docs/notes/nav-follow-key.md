# useNav follows a key from outside

An audit of the frontend's effects found five callers of `useNav` (`gui/frontend/src/lib/nav.ts`)
pushing a key the parent already owns into the hook's private cursor from an effect: the diff's
file list and commit list (the file or commit on screen) and the three Projects pages (a row
asked for through `revealOnProjectsPage`). Each such effect ran after a commit that still had the
old cursor, so the cursor was one render behind the key, and every change cost a second render.

## What changed

- `useNav(items, { follow })`. Each time `follow` changes to a non-null key, the cursor moves there
  during render (React's adjust-state-while-rendering pattern: the previous key is kept in state
  and compared), and the row is owed a scroll into view, as `setCursor` owes one. A key present on
  mount starts the cursor there and owes its row, as the old mount effect did.
- Between changes the cursor is the user's: a new list under the same key, or the key going back
  to null, leaves it alone. A key not among the items is held (no cursor shows) until a list has
  it, which is what `setCursor` already did with an unlisted key.
- The "same key again owes nothing" rule moved from a ref in the hook into the reveal's closure
  (`moved`), so the render-time path and `setCursor` share it, and the hook reads no ref during
  render (oxlint's `react/refs`).
- `FileList` and `CommitList` pass the current file's or commit's key as `follow`; their effects are
  gone. `FileList` keeps its comment: the cursor follows the file on screen, not the list.
- The Projects pages derive `asked` (the store's `reveal` when this page lists it, else null) and
  pass it as `follow`. Clearing the request is a store write, so it stays an effect, now keyed on
  `asked` alone. Clearing is also what lets the same row be asked for twice in a row: `asked` goes
  back to null in between, so the second ask is a change again. Before, the effect re-fired for
  the same reason (its `reveal` dependency went through null).

## Gotchas

- The reveal debt is a mutable object, and it is now written during render. That is safe because
  the write is idempotent for a given key (StrictMode's second render owes the same key) and the
  debt is paid only by a committed row's effect. A render React throws away after owing a key can
  leave that key owed; it is paid only if that row later becomes the cursor row, which a fresh
  move would owe anyway.
- A plain render-time derivation (`cursor = follow ?? userCursor`) would have lost the scroll:
  NavRow scrolls only a row it was owed, so the follow path has to owe it explicitly.

## Verified

- vitest: `src/lib/nav.test.tsx`, a table over the option's branches (key changes, key not among
  the items, a key listed later, list changing under an unchanged key, user moves then the key
  changes or goes null or comes back, key moving to where the user already is), plus a check that
  no commit shows a new key with the old cursor.
- e2e (mock daemon, WebKit), unchanged and green: `diff-viewer.spec.ts` (the keyboard brings its
  row into view in a virtualized list; a live update keeps the rail on the same file; the list on
  top comes back on the current row), `pr-diff-tab.spec.ts`, `projects.spec.ts`, and
  `app.spec.ts`'s "worktree.create from the palette reveals the new worktree on its project's page",
  which asserts the revealed row is in the viewport.
