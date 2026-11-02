# Project page 3: Worktrees without threads

PR 3 of three on the per-project page, after PR 1 (title block, SectionHeader, Details) and
PR 2 (the Checkouts table, the row right-click menus, the split Open in item). The design was
agreed with a user on 2026-11-01; the sketches were real app renders with injected DOM.

## What changed

- **Section title** (`components/projects/LeftoverWorktrees.tsx`): `SectionHeader` with the
  count and the hint, "Worktrees without threads (N) · a thread's worktree goes on its own
  once its work is on main". At the right is the ghost Broom "Remove the N that are clean"
  (project.worktree.cleanup, counted by `useCleanableCount` as before). The footer sentence is
  gone. With nothing kept, one muted line in the box: "Nothing kept. Every worktree here has
  a thread."
- **Table** in the Checkouts grammar (`rounded-lg border`, overline header `px-2 py-1`, body
  `p-0.5`, rows `h-9 rounded-md`, grid `px-2 gap-3`): Branch | Why it stayed | a blank icon
  column. The grid is `minmax(6rem,14rem) minmax(0,1fr) 3.25rem`, so no column ever drops.
  The reason shrinks and truncates first, then the branch.
- **Branch cell**: an amber dot while the worktree holds work (`holdsWork`), grey when clean;
  the branch in `text-code` with the tildified path as its tooltip.
- **Reason**: `text-body-sm` secondary, truncating, with a tooltip only when truncated.
- **Icons** (`RowAction`, 24px, muted): Show diff (`FileDiff`, only while it holds work; an
  empty 24px slot otherwise, so the icons line up) opens the Changes tab. Remove worktree
  (`Trash2`, red on hover) goes through `removeWorktree` and `RemoveWorktreeDialog`. Both are
  icon-only, with tooltips "Show diff" and "Remove worktree". The test ids
  `leftover-show-diff` and `leftover-remove` stay.
- **Rows are passive** (`NavRow passive`): no click and no hover tint. The cursor tint shows
  from the keyboard and while the row's menu is open.
- **Right-click menu** (`menus.ts` `leftoverMenu`, pure, vitest-tested per condition; the
  split item comes from `CheckoutMenuParts.tsx` `LEFTOVER_MENU_PARTS`):
  - Resume “<last archived thread>”, only when a thread was archived on it (`resumeWorktree`).
  - New thread here and New terminal here.
  - — Show changes, only while it holds work.
  - — Open in Finder (PR 2's `OpenInSplitItem` with the shared Open in list), Copy path, and
    Copy branch name (not when detached).
  - — Remove worktree (destructive).

## Decisions

- **Leftover rows join the page's keyboard list** after the checkouts' (ProjectPage's nav
  items are `[...checkouts, ...leftovers]`, both keyed `projectWorktreeKey`). That is what
  gives a row its cursor tint while its menu is open (RowContextMenu sets the cursor), and it
  lets ↑/↓, End and Shift+F10 / the ContextMenu key reach the leftovers. It also replaces
  LeftoverRow's own `reveal` effect. A worktree shown from elsewhere (ui.focus.project after
  worktree.create) now goes through ProjectPage's reveal path, which sets the cursor, and
  `NavRow` scrolls the cursor row into view. A path is never in both lists, so the keys
  cannot collide.
- `useLeftoverPaths` moved to `pageHooks.ts` beside `useCheckoutOrder`. ProjectPage reads it
  once for the nav items and passes the paths to `LeftoverWorktrees`.
- **The labelled Resume and New thread buttons are gone**; the menu has both. Resume shows
  only with an archived thread (it used to fall back to the composer, which New thread here
  now is) and names that thread, as Open “<name>” does on a checkout.
- **The count shows at 0**, like Checkouts. The empty line's reason is not the hint repeated:
  it says why nothing is kept.
- **`PROJECT_NARROW_BELOW` and the page's `narrow` flag are removed** (and `data-narrow` on
  the page with them). Nothing else used them. The index's Activity threshold, which was
  defined through the constant, is now the literal 840 in `INDEX_DROP_BELOW`.

## Gotchas

- `data-testid="leftover-row"` is on the grid span inside the NavRow, like `project-worktree`
  on a checkout. The cursor state (`aria-selected`) is on the NavRow
  (`[data-nav-key="pw:<project>::<path>"]`).
- The mock serves no app icons, so the PR screenshots inject the Finder and VS Code icons into
  `useAppIconsStore`. The icons are requested first, so the mock's empty answer does not
  overwrite them.

## Tests

- `menus.test.ts`: `leftoverMenu` for each condition (clean, archived thread, work, both,
  detached), the split part's payload, and each text item's store action.
- `ProjectPage.test.tsx`: the title (count, hint, bulk button), the header, each row's dot,
  branch, reason and icon slots, the tooltips, no row click and no hover tint, Show diff, the
  menus of a busy and a clean leftover with the cursor tint while open, Resume, New thread
  here, Show changes, End + Shift+F10 reaching the last leftover, the Remove flow from the icon
  and from the menu, Remove the N that are clean, and the empty line.
- e2e `projects.spec.ts`: with the side panel open and a smaller window, the reason truncates,
  the header keeps both columns and the icons stay inside the row (real width), then Resume
  from the right-click menu over the stream. `app.spec.ts`'s worktree.create reveal still
  passes through the cursor path.
