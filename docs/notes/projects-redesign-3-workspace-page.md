# Projects redesign 3: the workspace page replaces the card

PR 4 of the Projects redesign (direction D, agreed 2026-10-31), after PR 2
(`projects-redesign-1-index.md`, the index, project page, navigation and a placeholder
workspace page over the old card). PR 3 ("Worktrees without threads") runs in parallel and
touches the project page only.

## What changed

- **`WorkspacePage.tsx`** keeps PR 2's header (crumb › `Layers` + name + picker,
  "workspace · N projects", Open in Finder, New thread, Rename… and Remove workspace…) and
  composes three sections:
  - **Projects** (`WorkspaceProjects.tsx`): one row per member by name (kind icon via the
    shared `ProjectKindIcon`, name, `MapPin` "starts here" pill on the default primary, the
    index's caption: slug / "origin · not GitHub" / "local only" / "~/path · no git");
    hover "Start here" (`MapPin`, `workspace.set-primary`) and "Remove" (`Unlink`,
    `workspace.remove-project`, no confirm: nothing on disk changes); "Add project"
    (`FolderPlus`) in the section header is the old add-member picker. A rooted
    workspace's "Workspace folder" row (its root, "missing" when moved) comes first.
  - **Threads** (`WorkspaceThreads.tsx`): the non-archived threads that reference the
    workspace, working first then by activity; Branch (dot + mono) | Thread ("driver ·
    working", the status word tinted like the sidebar) | one column per member | hover
    `ChevronRight` (open) + `Ellipsis` (Show changes in <member> per git member with a
    checkout, Open in Finder, Copy path). Caption "1 working · 1 idle · 3 archived";
    archived threads are counted, not listed. Click or Enter opens the thread.
  - **Instructions and skills** (`WorkspaceInstructions.tsx`): `FileText` row (label the
    file's name, else "CLAUDE.md"; "None yet · Write instructions (starts a thread)" or
    the path · View (File tab in the page's panel) · Edit instructions); `Sparkles` Skills
    (names · Browse marketplace → Settings → Skills); `Folder` Folder (root "its root",
    else the managed dir "kept by the app" · `FinderMark` Open in Finder).
- **`lib/workspacePage.ts`**: `workspaceThreads` (which threads, order, counts),
  `workspaceThreadsCaption`, `memberCheckoutPath` (the thread's checkout_paths entry, its
  cwd for the primary), `memberCheckoutState` (the cell).
- **Deleted**: `WorkspaceCard.tsx`, `CollapseToggle.tsx` (only the card used it after PR
  2), `collapsedWorkspaces` and its setter/prune in `stores/ui.ts` and `stores/events.ts`
  (a saved value is ignored by `merge`, no version bump), `skillChips` / `SKILL_CHIPS` /
  `workspaceSummary` / `CardWorkspace` in `lib/workspaceCard.ts`.
- `showWorkspaceCard` is `showWorkspacePage` and no longer reveals a header row (the page
  has none); Add as workspace opens the page with the keyboard on its list.
- The index's workspace rows already read `workspaceContents` ("no instructions · 2
  skills", "CLAUDE.md · 2 skills") from the same `instructions`/`skills` fields: unchanged.
- Help skill: "The Projects page has a page per workspace (projects, threads, instructions
  file, skills)"; ARCHITECTURE's content-pane paragraph describes the page.

## Decisions

- **Member cell wording.** `<changes> · <branch state>`: changes from `changesCell`
  ("clean", "4 files"); branch state is "merged" when the checkout is not main, has an
  upstream, nothing to push or pull, and nothing ahead of the default branch; "no commits
  yet" for the same without an upstream; otherwise `syncCell` ("2 to push", "1 behind",
  "up to date", "not pushed"). Not the daemon's `merged_clean`: that is true for a fresh
  branch with no commits too (after its grace period), which would call a thread that just
  started "merged". Other cells: "not in this thread" (a member added after the thread was
  made), "made at the next start" (no path recorded, or a path the projects slice does not
  know), "folder · no git", "not registered".
- **A synthetic workspace's folder row** shows only while the folder is the default primary
  (after the project that started threads was removed, or a workspace without projects).
  The handoff says a synthetic workspace shows nothing extra; without the row nothing on
  the page would say where threads start. The Folder row in Instructions and skills says
  where the files live either way.
- **Write/Edit instructions' reach** reads "(starts a thread)" or "(sends to <thread>)"
  from the same `instructionsThread` rule `editWorkspaceInstructions` uses, so the link
  says what it will do.
- **Rename** is in place in the header (the picker swaps for `WorkspaceNameEditor`), from
  the header menu only: a double-click on the picker would open its menu. After Enter or
  Escape the keyboard goes back to the page's list (one animation frame later, only when
  focus fell to the body, so a click elsewhere keeps its focus).
- **Open in Finder in a thread's menu** reveals the thread's own folder: its primary's
  checkout (`worktree.reveal`), or the workspace's folder (`workspace.reveal`) when the
  primary is the workspace. Copy path copies the same cwd.
- **Keyboard**: member rows then thread rows; a member's Enter (or double-click) shows its
  main checkout's changes as the card did, a thread's opens it. Nav keys `m:<ws>::<project>`
  (unchanged) and `wt:<ws>::<thread>`.
- No new commands: every action is an existing `workspace.*`, `worktree.reveal`,
  `thread.new` / `thread.send` or GUI state (File/Changes tab, Settings page).

## Gotchas

- `react-refresh/only-export-components`: `openThread` and `useWorkspaceThreads` live in
  `workspaceHooks.ts`, not beside the components.
- `useWorkspaceThreads` selects one string (caption + ids) and memoises the split, so the
  nav items do not rebuild on every threads-slice update.
- The mock's worktrees made for a workspace thread have no upstream and nothing ahead, so
  they read "clean · no commits yet"; `worktree/dirty` makes one "2 files · …".
- Run e2e from a second worktree with `E2E_MOCK_PORT=7820 E2E_VITE_PORT=9270` so it does
  not share the default ports with another worktree's run.

## Verified

- `make check` green; vitest `lib/workspacePage.test.ts` (threads, caption, path, cell
  wording), `lib/workspaceCard.test.ts` and `stores/ui.test.ts` trimmed with the removals.
- `make gui-e2e`: `workspace-page.spec.ts` (was `workspace-cards.spec.ts`; synthetic and
  rooted pages, index contents, Start here, Add project / Remove, the threads table with
  member columns, archived counts, row menu, open by chevron / click / Enter, a
  workspace-primary thread's Finder, rename, Remove workspace, Open in Finder, New
  workspace, Write/Edit instructions start then steer, a project named "workspace",
  unregistered members, keyboard order, filter), `addproject-workspace.spec.ts` (Add as
  workspace lands on its page) and `projects.spec.ts`.
- Mock daemon + browser: screenshots of the synthetic and rooted pages with working
  threads and the member hover, dark and light, in the PR body.
