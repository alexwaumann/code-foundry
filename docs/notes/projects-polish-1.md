# Projects polish 1: kind states, collapse, filter

PR 1 of three for the Projects page (sketch variant A, `/tmp/cf-projects-sketch`). Frontend
only. Always-visible actions, overflow menus, thread counts, freshness/refresh, Publish /
Init git actions and worktree cleanup are PRs 2 and 3.

## What changed

- **New thread** on the project header, worktree row and workspace header uses lucide
  `SquarePen` (as the sidebar toolbar and Start page do for `session.new`), not `Sparkles`.
- **Kind states** (`projectKind` in `lib/projects.ts`, table-tested): GitHub (`GithubMark`,
  sky, slug), git without a remote (`FolderGit2` muted, "local only · no remote"), git with
  a non-GitHub remote (`FolderGit2` muted, "<first remote> · not GitHub"), no git (`Folder`
  muted, the existing `NoGitBadge`). The section carries `data-kind` (and still `data-git`);
  the icon's wrapper has a one-sentence `title`.
- **Collapse** per project and per workspace: `collapsedProjects` / `collapsedWorkspaces`
  in the persisted UI store (`setProjectCollapsed` / `setWorkspaceCollapsed` return whether
  anything changed, which is what `NavItem.toggle` wants). Chevron at the far left of the
  header (mouse-down does not take focus from the list; double-click on it does not open
  the panel tab). ←/→ on a header row collapse/expand: `useNav` already supported this
  through `NavItem.toggle`, so `lib/nav.ts` is unchanged. A collapsed header loses its
  bottom border and counts what it hides ("4 worktrees · 1 in a workspace", "2 members").
  `pageItems` takes the collapsed sets, so hidden rows leave the keyboard list.
- **Filter** in the pane header: `/` on the list focuses it, Escape clears it and gives the
  list the keyboard back. `filterProjects` (table-tested) matches case-insensitively on
  project name, GitHub slug, worktree branch and tildified path, workspace name and branch.

## Decisions and gotchas

- lucide-react 1.x dropped every brand icon, so there is no `Github` export: the mark is a
  local line icon, `components/icons/GithubMark.tsx` (lucide's former path).
- No persist version bump: the new keys are validated in `merge` (string arrays, else
  empty), so state saved before this simply has nothing collapsed.
- "N worktrees" on a collapsed project is the project's total, including the ones listed
  under workspaces; the "in a workspace" part says how many of those.
- The page still rebuilds only on membership changes: kind is read per header with narrow
  selectors, collapsed state is two arrays, and the filter's inputs (names, slugs,
  branches) are subscribed to only while the filter is non-empty.
- While filtering, every match shows expanded and the chevrons are disabled (toggling a
  state you cannot see would be confusing); the saved sets are untouched and come back
  when the filter is cleared.
- A project matched only through some of its worktrees drops the "N worktrees are in
  workspaces" note (the note describes the whole project); a name or slug match keeps it.
- The header counts are totals; each section title counts what is shown. "No matches."
  replaces a section's text only when the filter hides everything in a section that has
  something; an empty section keeps its usual explanation.
- The input is `type="text"`, not `search`: WebKit's search field adds its own cancel
  button and Escape handling.
- The mock already had all four kinds (code-foundry/ghostty-playground GitHub, dotfiles a
  non-GitHub `origin`, sketches remoteless, writing no git); no fixture changes.

e2e: `gui/frontend/e2e/projects.spec.ts`.
