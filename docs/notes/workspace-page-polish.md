# Workspace page polish (projects pages polish, PR B)

The workspace page now uses the same table and Details grammar as the project page.

## What changed

- **Projects card**: member rows still tint on hover, but nothing opens them. A double-click or
  Enter used to open the project's main checkout's changes in the page's side panel. That
  `activate` is gone from WorkspacePage's nav items, so a click only moves the cursor.
  **Remove** now asks first. The confirm lives in the daemon (`workspace.remove-project` has
  `Confirm` + `DynamicConfirm`), like the app's other removals, so the CLI asks too
  (`--yes` skips it). The prompt names the project and the workspace by name and says what is
  true in the store: nothing on disk is deleted, threads keep their checkouts, and new threads
  stop checking the project out.
- **Threads table**: uses the index table grammar (overline head, `rounded-lg border`,
  `p-0.5` body, 36px rows with a hover tint). The columns are Branch | Thread | Changes |
  hover › and ⋯. Thread shows the name only; the status dot carries the status.
  Changes is `lib/workspacePage.ts threadChangesCell`: the thread's member checkouts' files
  and `baseAhead` commits, summed ("3 files · 2 commits"). It shows muted "clean" with nothing
  and "—" with no checkout yet. The per-member columns and `memberCheckoutState` are gone. The
  row's ⋯ lists "Show changes in <project>" only for members whose checkout is not clean
  (`changedCheckouts`, built on `checkoutHasChanges`).
- **Instructions and skills**: rows use `DetailRow`, moved out of ProjectDetails.tsx into
  DetailRow.tsx (a clean move with optional `icon`, `detail`, `valueTestId` and `data`).
  Buttons sit at the right (`DetailButton`). "starts a thread" / "sends to X" is now Edit
  instructions' tooltip, because that information is not on screen. The Folder row has Copy
  path and the split Open in Finder | ⋯.
- **Open in, generalised**: `openIn.ts` defines `OpenInTarget` (reveal, openWith(bundleId),
  terminal or null), with `checkoutOpenIn` and `workspaceOpenIn`. `OpenInList`, `OpenInSplit`
  (Details' button) and `OpenInSplitItem` (a menu's split item) take a target.
  `OpenInSplitItem` takes `menu="context" | "dropdown"` and picks the matching Radix sub
  primitives. `DropdownMenuSubTrigger` gained `chevron={false}`, as the context menu's has.
- **workspaceMenu**: Open in Finder is the `workspace-open-in` part. `OverflowMenu` now draws
  parts too (`MenuEntries`, shared with RowContextMenu) and provides `RowMenuPickContext`, so
  the same split item works in the page's ⋯ and in the index row's right-click menu.

## New command

`workspace.open.editor <workspace> --app <bundle id>` opens the workspace folder (its root,
else the folder the app keeps) in an installed editor. `worktree.open.editor` cannot do it
because it only opens registered worktrees. The app is checked against `ListEditorApps`, with
one refresh, the same rule gitops uses. The command is NoPalette because its required arg is an
opaque bundle id. Terminal in the workspace's Open in list is the existing New terminal
(`newWorkspaceTerminal`). It is left out where the folder has no place for a shell, as in the
menu.

## Gotchas

- `DropdownMenuSubTrigger` has no `relative` (the context menu's item class does).
  `OPEN_IN_ITEM` now adds it, because the › block's `after:` is positioned absolutely.
- The page-level vitest needs `@/api/gitops` mocked with `cardGitopsFakes` and
  `card.editors` set, or the Open in list has no editors.
- `e2e/fixtures.ts selectWorktree(…, workspaceId)` used to double-click a member row. It now
  opens the Changes tab directly; no spec passed a workspace.
