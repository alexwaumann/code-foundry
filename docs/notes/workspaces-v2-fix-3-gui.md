# Workspaces v2, fuzz round C fixes: the GUI

Status: done on branch `cf/workspaces-v2-fix-gui` (off `main` after #349-#356). Fixes the
findings of a GUI fuzz round over the Projects page's workspace cards, New workspace, Also
in, the removed Workspace surface and the Add Project scan. Two other fixers ran in
parallel: `cf/workspaces-v2-fix-workspace` (the workspace store) and
`cf/workspaces-v2-fix-threads` (the thread store). PR 3 (`cf/workspaces-v2-composer`)
owns the composer, the sidebar, `HeaderActions.tsx` and `lib/threadRow.ts`; none of them is
touched here. PR 3 merged (#357) while this was built; the branch is rebased on it, and the
card's name order reuses its `lib/projectSet.ts byName`.

## Per finding

1. **Reveal in Finder panicked (nil RevealFunc).** `RegisterWorkspaceReveal` defaults a nil
   reveal to `RevealInFinder`, as `RegisterSettings` does (the daemon passes none).
   `TestWorkspaceRevealNilFunc` registers with nil and reveals a missing folder: `open -R`'s
   error comes back, no panic, and Finder never opens.
2. **Escape renamed; Enter renamed twice.** The name editor is its own component
   (`components/projects/WorkspaceNameEditor.tsx`). Enter and Escape settle the edit (a ref)
   before giving the keyboard back to the page's list; the blur that the focus move causes
   finds it settled and does nothing. Escape keeps the stored name; leaving the field renames
   like Enter (a refused name is dropped). Unit test with Testing Library
   (`WorkspaceNameEditor.test.tsx`) and e2e (`workspace-cards.spec.ts`, rename test).
3. **Removing a synthetic workspace under running threads.** Skipped: the daemon side
   (refuse while threads run in the folder) is `cf/workspaces-v2-fix-workspace`'s; the
   sidebar badge, line 2 and the header's location chip are PR 3's (`threadRowModel`).
4. **The star on a project named "workspace".** `setWorkspacePrimary`,
   `addWorkspaceProject` and `removeWorkspaceProject` send the project's id, never its name
   (the daemon reads "workspace" in any case as the folder; ids never collide). New
   workspace still sends names (`workspace.new --projects` has no keyword). The mock's
   remove takes a member's id first (an unregistered one too), like the daemon's
   `memberRef`. e2e: a project renamed "workspace" by a new mock control
   (`POST /__mock/project/rename`).
5. **Unregistered default primary.** Skipped: the workspace store's reaction to an
   unregister is `cf/workspaces-v2-fix-workspace`'s.
6. **Unregistered member opened a blank tab.** The member row's activate shows the main
   worktree only when the project has one (`mainWorktreePath` is "" for an unknown
   project); the row reads its id and "not registered" (`data-unregistered`). e2e.
7. **Edit instructions toasted CLI text and re-sent on every press.** A pure rule,
   `lib/workspaceCard.ts instructionsStep`: start when no thread is in the folder, else steer
   it; but when the thread the last press sent to (or started) is still live (busy, or
   starting), a press only selects it. The last press per workspace is kept in
   `stores/workspaceActions.ts` (module state, not persisted; a new thread's id from
   `thread.new`'s JSON). The leak was `runCommand`, which toasts the daemon's message
   ("sent to thread …; wait with: code-foundry thread wait …", built for the CLI): the steer
   now runs quiet and toasts "Sent to <thread name>". Starting a thread shows no toast (the
   thread is selected). The mock's `thread.send` now answers with the daemon's CLI line so
   the e2e catches a leak.
8. **An open name editor reverted a rename made elsewhere.** Until the user types, the field
   shows the stored name (a draft that is null), so it follows a rename from the CLI and an
   untouched Enter renames nothing; once they have typed, Enter commits theirs (last write
   wins). Unit tests.
9. **Members ordered by id.** `membersByName` (name, case-insensitive, id as the tiebreak;
   an unregistered member by its id) orders the card's rows and the page's keyboard rows
   (`pageItems` takes the names: the page's structure key now carries project names). The
   stored order stays by id. Also in sorts its rows the same way. The New workspace dialog
   has no selection summary: its list is the projects slice's order, already by name
   (`localeCompare`), and it still sends the picks in that order (the first is the default
   primary). e2e.
10. **No Worktree tab for a thread in its workspace's folder.** The Worktree surface gains a
    folder head instead of a new surface: `selectionFolder` (a thread with a workspace, no
    primary project, its cwd the workspace's folder, `/private/tmp` = `/tmp`) gives a tab
    with params `{ workspace, path }` titled with the workspace's name;
    `WorkspaceFolderPanelView` shows the workspace's name, the folder (tildified, the full
    path on hover) and who else works there, no git facts, then Also in with every member
    checkout (`alsoInRows(…, folder)`; a one-project workspace reads Checkouts too). A row
    opens that checkout as its own Worktree tab. T in the panel, the thread header's
    location chip and `view.panel.worktree` all reach it: the daemon's
    `view.panel.worktree` now offers itself for that context (thread + workspace + cwd, no
    project) and its Run check accepts a thread with a workspace and no project
    (`internal/command/commands_view*.go`; `view.panel.diff` keeps the stricter check). A
    removed workspace's folder tab says so. e2e and the live app.
11. **Card stale for root files added later.** Skipped: the workspace store's
    (`cf/workspaces-v2-fix-workspace`).
12. **Missing root not marked.** Skipped: the daemon side is
    `cf/workspaces-v2-fix-workspace`'s; the card needs a field from it first.
13. **Skills line.** The label sits on the first row of chips (`items-start`, both rows
    `h-7`/chips `h-5` with `py-1`), at most 8 chips (`SKILL_CHIPS`), then a "+N more" chip
    whose tooltip lists the rest (hidden information). A long name truncates in its chip
    (`max-w-48`) with a tooltip only while cut. e2e (count, tooltip, alignment).
14. **Smaller items.**
    * The page filter matches a workspace by its name or a member project's name (the whole
      card shows).
    * Escape on the Add Project two-choice step goes back to the path, as typed, focused;
      Escape there closes the dialog. The tab registers a way back while the choice shows
      and the dialog's `onEscapeKeyDown` takes it first (Radix listens on the document in
      capture, so stopping the key in the tab would not do).
    * After Add as workspace the new card's header becomes the page's cursor row (its
      highlight, scrolled into view) once the card arrives (`stores/projectsPage.ts`; the
      page had no flash pattern, so no brief highlight was added: the cursor is the page's
      own pointer).
    * `collapsedWorkspaces` drops ids a `removed` event or a snapshot no longer has.
    * The stale comments about the Workspace surface are gone (`bottomActions`,
      `worktreePanel`, `surfaces/worktree`, `types`, `linkedprs`, `noProject`).
      `HeaderActions.tsx`'s hidden `view.panel.workspace` button is PR 3's file.
    * The `/tmp` vs `/private/tmp` mismatch in Checkouts' paths is isolated-home only; not
      changed (the folder match already normalises it).

## Gotchas

* `GET /__mock/workspaces` returns the mock's own shape (members as ids);
  `addproject-workspace.spec.ts` read them as `{ projectId }` and failed on main since PR
  4's mock change. Its helper takes both now.
* A new mock thread with a prompt is busy and STARTING for ~2 s; the Edit instructions e2e
  waits for CONNECTED before marking it idle, else a press only focuses it (by design).
* React renders a boolean `data-*` as "true".

## Verified

* `make check` green. Go: `TestWorkspaceRevealNilFunc`, `TestPanelWorktreeWorkspaceFolder`,
  `view.panel.worktree` availability rows. Vitest: `WorkspaceNameEditor.test.tsx`,
  `instructionsStep`, `membersByName`, `skillChips`, `alsoInRows` (by name, folder head),
  `checkoutsKey` (min 1), `pageItems` by name, `filterProjects` by member,
  `selectionFolder`/`folderTab`, `pruneCollapsedWorkspaces`.
* `make gui-e2e`: `workspace-cards.spec.ts` (7 new tests: findings 4, 6, 7, 9, 10, 13, 14;
  the rename test extended for 2; set primary, add/remove and Edit instructions updated)
  and `addproject-workspace.spec.ts` (Escape back, the cursor on the new card). The whole
  suite on the rebased branch: 602 passed.
* Live app (isolated home, scratch `~/cfv2-fix-c/product` with six repos, a root
  `CLAUDE.md` and 11 skills, added with `project add-workspace`; a Haiku 5.5 medium thread
  started in the workspace's folder): the card listed api, billing, docs-site, mobile, web,
  Zeta-tools (ids in hex order otherwise), 8 skill chips with "+3 more" and the long name
  truncated; `view.panel.worktree --thread … --focus` opened the folder head ("product",
  `~/cfv2-fix-c/product`) with the six checkouts under Also in. Dark and light screenshots
  in the PR body. The window was moved and sized through accessibility, the panel hidden
  and the theme and zoom set through the isolated settings; the three WebKit localStorage
  keys the app wrote (`code-foundry.ui`, `code-foundry.panel`, `cf.theme`) were put back
  afterwards, and the scratch home, repos and transcript folder deleted.
