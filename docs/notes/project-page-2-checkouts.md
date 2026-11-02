# Project page 2: the Checkouts table

PR 2 of three on the per-project page. PR 1 does the title block, the page width, the
section titles and Details. PR 3 does Worktrees without threads and reuses this PR's split
Open in item. The design was agreed with a user on 2026-11-01; the sketches were real app
renders with injected DOM.

## What changed

- **Table grammar** (`components/projects/CheckoutsTable.tsx`): the Projects index's table.
  That is `rounded-lg border`, an overline header row (`px-2 py-1`), a `p-0.5` body, and
  `h-9 rounded-md` rows whose grid is `px-2 gap-3`. Branch takes the room; Threads 9.5rem,
  Changes 6.5rem, Sync 7rem, Pull request 7.5rem.
- **Columns drop by the table's own width** (`lib/projects.ts` `checkoutColumns`,
  `CHECKOUT_DROP_BELOW`): Sync below 900px, Threads below 720, Changes below 560. Branch
  always shows, and Pull request always shows on GitHub. Sync needs a remote and Pull request
  needs GitHub. This replaces the table's use of `narrow`. The page keeps `narrow` for its
  header and the leftovers, which PR 1 and PR 3 own.
- **Branch cell**: the status dot, the branch (`text-code`, with a tooltip showing the
  tildified path), and then a signal (muted, 14px):
  - lucide `FolderRoot` on the main checkout. Its tooltip is "**Main checkout** · the project
    folder, ~/…". It replaces the "main" pill.
  - `Layers` on a workspace's checkout. Its card shows the workspace name, "Workspace ·
    <members>" and "<N> thread(s) · <names>" (the open threads on this checkout from that
    workspace). It replaces the workspace pill.
- **Rows are passive** (`NavRow passive`): no click, no double-click and no hover tint. The PR
  pill keeps its own click. The arrow keys still move the list's cursor, and the cursor row
  gets the selected tint, which a row also shows while its menu is open. The nav items have no
  `activate`, so Enter does nothing and the row's `openChangesTab` is gone.
- **Keyboard path to the menu**: the ContextMenu key or Shift+F10 on the page's list
  dispatches a `contextmenu` at the start of the cursor row (`rowMenu.ts`
  `openCursorRowMenu`, wired in ProjectPage's `onKeyDown`).
- **Right-click menu** (`menus.ts` `checkoutMenu`, pure; the parts are in
  `CheckoutMenuParts.tsx`):
  - Open thread ›, a submenu with a status dot, the name and a muted status word, only with
    two or more open threads. With exactly one thread it is a direct item: Open “<name>”.
  - New thread here, New terminal here.
  - — Show changes (uncommitted files, or commits ahead of its base: `checkoutHasChanges`),
    and Open pull request #N.
  - — Open in Finder (the split item), Copy path, Copy branch name (not when detached), and
    Run action › (only when the project has actions).
  - — Remove worktree (not on main).
- **Split Open in item** (`OpenInMenuItem.tsx` `OpenInSplitItem`, for reuse in PR 3): a click,
  Enter or Space reveals in Finder. The › block (the item's last 32px) opens a submenu on
  hover, click or ArrowRight. The submenu lists Finder, the installed editors (`AppIcon`) and,
  after a separator, Terminal. That list is `OpenInList` in PR 1's `OpenInFinder.tsx`, shared
  with Details' ⋯: it takes the menu's item and separator parts. The always-mounted control
  reads `useEditorApps`, so the editors are known before the menu opens. It hovers like `GearMenuItem`: the left block is `before:` and
  ends 34px short, and the › block is the span's `after:`. The block under the pointer is
  bright and the other is at half strength. While the submenu is open, the › block is bright
  and the left block is at half strength. The chevron always shows, because it marks a
  submenu.
- **Run action ›** uses `GearMenuItem` with a new `item` prop (the context menu's item part)
  and `gearTestId`. A pick runs the action in this checkout, and the gear opens the editor;
  the submenu ends with Add action. `components/actions/ActionsMenu.tsx` had no other user,
  so it is deleted. Its test became `CheckoutActions.test.tsx`, which drives the submenu.
- **RowContextMenu parts**: entries are `OverflowItem` or a typed part `{ kind, testId, … }`
  drawn by a registry the caller passes (`RowMenuParts<P>`). Runs of text items still go
  through `MenuItems`. The types, the context and the keyboard helper live in `rowMenu.ts`
  (a component file may export only components). A context (`RowMenuPickContext`) gives parts `pick` (run after the
  menu closes) and `close` (close from a non-item, then run).
- `ContextMenuSubTrigger` takes `chevron={false}`. `BADGE_WORD` (the thread status words)
  moved to `lib/thread.ts`, shared with WorkspaceThreads.

## Decisions

- **The table measures itself** (`useWidth` on the table) instead of ProjectPage passing a
  width. The ladder's widths are the table's. ProjectPage passes only `remote` and `github`;
  its `narrow` (`PROJECT_NARROW_BELOW`) no longer touches the table and stays for the
  leftovers.
- **Copy path and Copy branch name toast** ("Path copied"). A menu item has no other place
  to confirm itself. The Details copy button (PR 1) uses its check icon instead.
- **Moving the pointer onto the split item's text closes its open submenu.** The left block
  is the reveal target, and the submenu belongs to the › block. A click on the text then
  closes the menu with a single Escape.
- The workspace card is a `Tip` with a rich label at the 260px card width, not a new
  hover-card component.

## Gotchas

- **Radix's sub trigger opens on any pointer move and on click.** The split item calls
  `preventDefault` in its own `onPointerMove` and `onClick` when the target is outside the ›
  block (`composeEventHandlers` then skips Radix), and focuses the item itself. That also
  skips Radix's pointer-grace check for another open submenu. That is harmless here.
- **Radix's ContextMenu root has no `open` prop**, so a non-item cannot close it. `close`
  dispatches an Escape keydown from inside the content: the dismissable layer listens on the
  document in the capture phase, and the content's `onKeyDown` stops the key from reaching the
  page. If the item's own submenu is open, it is closed first (one frame), because the
  topmost layer takes the Escape.
- The mock answers app icons with none, so the PR screenshots inject the Finder and VS Code
  icons into `useAppIconsStore`. In the app they come from the installed bundles.

## Tests

- `lib/projects.test.ts`: `checkoutColumns` at each threshold and kind; `checkoutHasChanges`.
- `menus.test.ts`: `checkoutMenu` for each condition (no thread, one, two, changes, PR, busy,
  main, detached), the parts' payloads, and each text item's store action.
- `CheckoutsTable.test.tsx`: the columns at 1100/860/700/520 (header and cells), no click and
  no hover tint, the branch path tooltip, the FolderRoot tooltip, the workspace card, Open
  thread's rows and pick, and the split item (click and Enter reveal, ArrowRight and the ›
  block open the apps, editor and Terminal picks, and the block classes).
- `ProjectPage.test.tsx`: a row click opens nothing; End, Enter, Shift+F10 and ContextMenu;
  the menus of main and of a busy worktree; Show changes; Remove worktree.
- `CheckoutActions.test.tsx` (was ActionsMenu.test.tsx): Run action's items, gear, Add action,
  a run, and add/edit/delete.
- e2e `projects.spec.ts`: Shift+F10 in a real browser with focus returning; the split item's
  pseudo-element geometry and its three colours; the side panel opened from Show changes.
  `threads.spec.ts` and `actions.spec.ts` go through the menu. The `selectWorktree` and
  `selectProject` fixtures open the Changes tab through the store, since rows have no click.
