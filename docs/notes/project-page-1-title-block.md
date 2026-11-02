# Project page 1: title block, width, Details

PR 1 of three on a project's page (2: the Checkouts table; 3: Worktrees without threads).
It covers the page's frame: the pane header, a title block, the content width, the shared
section title, and the Details card. The workspace page gets the same frame. The tables are
not restyled here.

## What changed

- **Width**: the content column is `max-w-6xl` in a `px-5 py-4` scroller on the project and
  workspace pages, the same as the index.
- **Pane header**: only the crumb, the page picker (or the inline rename editor) and the
  Bottom/Panel toggles. The meta slug, Refresh, Terminal, New thread, ⋯ and the "Refresh
  failed" pill are gone from it.
- **Title block** (`bits.tsx TitleBlock`, `ProjectTitle.tsx`, `WorkspaceTitle.tsx`): the
  first thing in the content column. A 20px kind icon, the name (`text-title`, an `h1`) and
  a `text-caption` muted meta line; at the right only a ⋯ (28px, `OverflowMenu size="md"`).
  - Project meta: the slug (GitHub), the kind meta ("local only · no remote", "origin · not
    GitHub") or, without git, the tildified path; then the default branch with its checks;
    then "refreshed just now" and a 20px refresh button (testid `project-refresh`, tooltip
    "Fetch and refresh", spins while busy). A failed refresh turns that part red: "Refresh
    failed · 14m ago" (`refreshFailedText`), with the error as its tooltip. Without git the
    path is the whole line: no branch, no refresh.
  - Below `PROJECT_TITLE_COMPACT_BELOW` (720px of content) the slug or kind meta drops first.
    The path of a project without git stays, because it is all there is.
  - Workspace meta: "2 projects · CLAUDE.md · 3 skills" (`workspaceContents`). Its ⋯ is
    `workspaceMenu` (New thread first). Its header buttons, Open in Finder and New thread,
    are gone; both are in the ⋯.
- **Default branch** (`DefaultBranch.tsx`): the index's cell moved out of `ProjectsIndex.tsx`
  into a shared component with two variants. The "cell" variant is unchanged. The "title"
  variant is one `ChecksBadge` in the checks' tone with the branch named first ("⊗ main 2/16
  failing"). `ChecksBadge` gained optional `branch` and `className` props. A click on
  failing checks opens the first failed one, as on the index.
- **Project ⋯** (`menus.ts projectMenu(…, { page: true })`): New thread, New terminal |
  Rename, Clean up merged worktrees (git with a remote), Publish to GitHub or Initialize git
  | Remove project. It has no Open in Finder and no New action, because Details has both.
  The index row's context menu keeps its list; the old `newAction` option is gone.
- **Section titles** (`bits.tsx SectionHeader`): re-implemented with the index's grammar:
  an `h2` in `text-title`, an optional "(N)" caption (`count`, testid `section-count`), a
  "· hint" caption (`detail`, testid `section-hint`) and a right slot. The index's own
  `SectionTitle` is deleted, so the index, project and workspace pages share one component.
  Checkouts reads "Checkouts (3) · 2 threads working": the count is the table's rows, and
  the hint (`checkoutsHint`) is left out while no thread works. The workspace's Projects
  section gets its count. `checkoutsSummary` ("main plus N worktrees") is gone.
- **Details** (`ProjectDetails.tsx`): rows are a grid, `label | value | controls`, at
  `8.25rem minmax(0,1fr) auto`. The card has no padding and each row carries `px-3`, so the
  dividers run edge to edge. A truncated value shows in full in a tooltip (the path shows
  untildified).
  - Path: a copy icon button and the split Open in Finder control
    (`OpenInFinder.tsx`). Copy uses `lib/useCopied`: a green check for 1.5s, no toast,
    tooltip "Copy path" (then "Copied"). Open in Finder's click reveals the main checkout.
    Its ⋯ lists Finder, the installed editors (real icons, `useEditorApps`), a separator,
    and Terminal (a new terminal in the main checkout). This is the thread info card's Open
    in list. Below 720px only the Finder icon shows, with a tooltip.
  - Default branch row: removed (the title block has it). "refreshed …" moved there too.
  - Worktrees: "6 · 3 made by Code Foundry, in ~/.code-foundry/worktrees" (`worktreesDetail`
    rewritten). "all made by Code Foundry" when Code Foundry made every one. The folder is
    left out when the worktrees share none, only "/", or only the home folder (the stray
    "~ ·").
  - Actions: the names joined with " · " (truncating), or "none". At the right a ghost
    "Edit ⌄" opens a menu: a muted "Edit an action" label, the actions with their icons
    (each opens its editor), a separator, then New action. Without actions it is a ghost
    "Add action".
- The no-git project's Threads block stays, under the new section title.

## Decisions

- **Split hover on two real buttons**, not the thread info card's pseudo-element blocks.
  Details' control is a standalone control, not a full-width row, so each half can be its
  own button with its own background. The rule is the same: the half under the pointer is
  bright and the other `/50`, with a 2px seam (`ml-0.5`). While the menu is up only the ⋯
  is lit. The two "menu open" rules carry `!`: the `group-has-[…]/split` dim rules count
  their `:has()` argument in specificity (0,3,0) and would beat `aria-expanded:` (0,2,0)
  and `hover:`.
- **The default branch for a project not on GitHub** (or before the GitHub status arrives)
  shows by name from the store, with no checks. The brief said "nothing for non-GitHub". But
  with the Details row gone, a git project not on GitHub would otherwise show its default
  branch nowhere on its page. Only the checks are GitHub-only.
- **New action without a Plus icon**: the sketch drew one, but the menu rule allows
  only identity icons (app, action and status icons).
- **Leftover section untouched**: `LeftoverWorktrees.tsx` passes no `count`, so it renders
  in the new grammar as "Worktrees without threads · 3 kept" with no code change. PR 3
  restyles it. `CheckoutsTable.tsx` and `LeftoverWorktrees.tsx` have no edits in this PR.
  Their `narrow` flag (`PROJECT_NARROW_BELOW`, 840px) stays until PR 2 replaces it.
- `OverflowMenu` gained `size` ("sm" for rows, "md" for title blocks) rather than a
  free-form class.
- `OpenInFinder.tsx` uses `DropdownMenuItem`s directly. PR 2's split context-menu item
  needs the same list as `ContextMenuItem`s; that is the moment to share it.

## Tests

- `lib/projects.test.ts`: `checkoutsHint`, `refreshFailedText`, `worktreesDetail` (table:
  shared folder, none, some, all, one, home-only), and `actionsDetail` over names.
- `menus.test.ts`: the page's ⋯ for GitHub, git without a remote, and no git.
- `ProjectPage.test.tsx`: what the pane header no longer holds; the title block's name, slug
  and meta line with the checks badge; the Checkouts title; Details' values; the section
  order (title first); the page's ⋯ items with New terminal and New thread run from it.
  Copy's check (fake timers, no toast, tooltip). Open in Finder reveals, and its ⋯ lists
  Finder, an editor and Terminal, each running its command. The kind variants: a branch by
  name off GitHub, and no git is the path alone. A failed refresh turns the part red with
  the error as its tooltip.
- `ActionsMenu.test.tsx`: the Actions row names them; the Edit menu's label, the actions
  with icons (one opens its editor), and New action adding one; "Add action" without any.
- `WorkspacePage.test.tsx`: the workspace title block, its ⋯ (reveal, New thread), and the
  Projects (N) title.
- e2e `projects.spec.ts`: the narrow layout now checks `data-compact`, the slug dropping
  and Open in Finder going icon-only, then coming back. A new test checks the split hover's
  computed colours (bright/half both ways, the 2px seam, menu open = ⋯ only, even with the
  pointer back on the label). `terminal-routing.spec.ts` starts its Projects-page shell
  from the ⋯'s New terminal.
