# Projects table 1: the index as a table

PR 1 of three on the Projects page (agreed 2026-11-01). PR 2 adds the row context menus and
strips icons and trailing "…" from every menu in the app; PR 3 adds `project.rename`.

## What changed

- **The index is a table like the Pull Requests page's**: `max-w-6xl`, an `h2` section
  title in `text-title` with a muted "(N)" of the rows shown, an overline header row, a
  `rounded-lg border` table with `p-0.5` around 36px single-line rows (`NavRow`, `rounded-md`).
  Projects: Project | Activity | Default branch | Needs a look | Updated. Workspaces:
  Workspace | Activity | Projects | Contents | Updated. Both tables share their tracks
  (flexible, with a floor, as the PRs page learned), so the columns line up.
- **Name cells are icon + name**. No caption: the kind icon carries the kind. The
  workspace's members moved to its Projects column. `indexCaption` is now only the workspace
  page's member caption, so it is `memberCaption`.
- **Default branch**: the branch (mono, muted) and the checks rollup in the PRs page's
  `ChecksBadge`. Data is `GhService.GetRepoActivity` → `DefaultBranchStatus`, which the GUI
  had stopped reading (the mapping went with the worktree overview in ad984af21), so
  `api/gh.ts` maps it again, slimmed to what the column reads (`RepoActivityView`:
  slug + default branch), and `stores/gh.ts` has `repoActivityResource` (keyed by the
  lower-case slug, invalidated by `repo_activity_updated`). Each row watches it through
  `useResource`, so nothing holds it off screen. The daemon fills it for every tracked
  (registered GitHub) repository on its regular poll; GetRepoActivity is a snapshot read
  and does not start polling. `defaultBranchCell` (lib/projects.ts) decides: "—" off GitHub,
  before the first read, and while the daemon knows only an error (`fetchedAt` unset), since
  an empty rollup would read "no checks". A click on the checks opens the first failed
  check that has a link and stops there (the row does not open); a passing or pending badge
  is not a button, so a click there opens the row like anywhere else.
- **Needs a look**: the pills, then "Publish to GitHub" (no ellipsis, also in the project
  menu) or "Initialize git". The project page's Publish button keeps its "…": buttons are
  outside this series' menu rule.
- **No hover actions and no chevron.** The row is a `NavRow` as before (click/Enter opens,
  ↑/↓, `/` filter, Escape). New thread, New terminal and the project menu are on the project
  page's header (and the row's context menu in PR 2).
- **Header**: icon, "Projects", the filter, the bottom/panel toggles. "Add project"
  (FolderPlus) and "Add workspace" (Layers) are outline `h-7` buttons on their section
  titles; test ids stay `projects-register` / `projects-new-workspace`. The empty hint reads
  "None yet: Add workspace, or `code-foundry workspace new`." The New workspace dialog keeps
  its title.
- **Narrowing drops columns, not the layout** (`indexColumns`, measured on the scroll box
  like the project page): Activity below 840px of content (`PROJECT_NARROW_BELOW`), Updated
  below 700, Default branch below 600. The workspaces table drops Activity and Updated at the
  same widths, and Contents where projects drop Default branch; its Projects column stays.

## Gotchas

- The middle of a code-foundry row (mock) is its failing checks, which open a URL instead of
  the page. `openProjectPage` in `e2e/fixtures.ts` and the specs click the project's name.
- `src/lib/tooltips.test.ts` flags any JSX `title=` prop as a native tooltip, so the section
  title component takes `heading`.
- Specs that used the removed row actions (New thread, New terminal, the row's ⋯) now go
  through the project page header: `create`, `sidebar`, `terminal-routing`,
  `workspace-page`, `nogit`. `layout.spec.ts` checks the filter as the header's no-drag control.
- `sidebar.spec.ts` "hovering a thread row shows its tooltip…" and "a multi-project
  thread's card…" fail on main as well (the tooltip's chips); not touched here.
