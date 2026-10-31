# Icon system: one glyph per concept

PR 1 of the Projects page redesign. The icon set below is locked; this PR applies it
everywhere outside `gui/frontend/src/components/projects/`, which the Projects page rewrite
(PRs 2-4) replaces, so that directory was not touched (its sidebar entry, `ProjectsNav`,
moves to `Folders` there).

## The table

| Concept | Icon | Where (outside components/projects) |
|---|---|---|
| Projects (sidebar entry, index header, crumb) | `Folders` | Projects page rewrite (sidebar entry lives in ProjectsPage.tsx) |
| GitHub project | `GithubMark`, info tint | `ProjectKindIcon` everywhere a project is shown |
| Git project without GitHub (other remote or none) | `FolderGit2` | `ProjectKindIcon`; the Add project folder listing's git folders |
| Plain folder (no git) | `Folder` | `ProjectKindIcon`; the Add project folder listing's other folders |
| Workspace | `Layers` | unchanged everywhere |
| Checkout row / branch | `GitBranch` | unchanged (composer Work in, sidebar card, thread info card) |
| Pull request states | `prStateLook` (GitPullRequest / GitPullRequestDraft / GitMerge / GitPullRequestClosed) | unchanged |
| Checks | ChecksBadge (CircleCheck / CircleX / CircleDashed) | unchanged |
| Worktrees to tidy, clean up | `Broom` | Projects page only |
| Refresh / refresh failed | `RefreshCw` / `TriangleAlert` | unchanged (file header Refresh) |
| New thread | `SquarePen` | Projects page |
| Terminal | `SquareTerminal` | unchanged (row menu, thread info card) |
| Show changes / diff, the Changes tab | `FileDiff` (replaces `Diff`) | Changes surface tab icon, thread info card Changes row |
| Resume | `ArchiveRestore` | thread menus' Unarchive (already) |
| Remove worktree | `Trash2` | Projects page |
| Remove project / remove a project from a set | `Unlink` | thread info card Run in menu's per-member remove (was `X`) |
| Publish to GitHub / Initialize git | `CloudUpload` / `GitBranchPlus` | unchanged (Add project New tab's publish, Publish dialog) |
| Open in Finder (was "Reveal in Finder") | `FinderMark` | File and Diff tab headers, File tab empty states, Settings sheet, thread info card (already) |
| Copy path | `Copy` | unchanged (file header) |
| Project actions | `Play` | unchanged (thread info card) |
| Add project, the Add project dialog's New tab | `FolderPlus` (replaces `Sparkles`) | Add project dialog New tab and its Create button |
| More | `Ellipsis` | unchanged |
| Starts here (workspace primary) | `MapPin` (replaces `Star`) | composer Run in picker trigger (was `FolderOpen`) |
| Instructions / Skills | `FileText` / `Sparkles` | Settings → Skills keeps `Sparkles`; Themes' "Ask the model" moved to `WandSparkles` (the thread info card's ask-the-model glyph) so `Sparkles` means skills only |

## What changed

- `components/icons/projectKind.ts` (`PROJECT_KIND_ICONS`, `useProjectKind`),
  `GithubProjectMark.tsx` and `ProjectKindIcon.tsx` (`ProjectKindIcon`, `ProjectIcon`).
  The map is keyed by `lib/projects` `projectKind(...).kind`. The GitHub mark's info tint is
  applied after the caller's className, so a caller's muted colour reaches only the folder
  kinds. The svg carries `data-project-kind` (not `data-kind`: e2e already selects on that
  attribute for other things).
- Uses: sidebar row card's project line (was `FolderGit2`/`Folder` by no-git only), the
  thread header crumb for a one-project thread (was `Folder`), the thread menus' and the
  palette's Run in members (were `FolderGit2` in the info tint for every kind), the thread
  info card's project row (was `FolderOpen`), the composer's Work in pill when it is the
  project's own folder (was `FolderGit2`) and the Run in picker's options (no icon before).
- "Reveal in Finder" is "Open in Finder" with `FinderMark` (was `FolderSearch`) in the
  file header and File tab states; the Settings sheet's "Reveal settings file" (`FileText`)
  is "Open settings file in Finder". Command titles: worktree.reveal "Open Worktree in
  Finder", workspace.reveal "Open Workspace in Finder", settings.reveal "Open Settings File
  in Finder" (verb names unchanged). The gitops op label reads "Open <name> in Finder" and
  its summary "opened <path> in Finder".

## Decisions and gotchas

- The composer's project pickers keep their two-letter hued badges (`ProjectBadge`): a
  distinct identity mark, not a kind glyph. The composer member chips keep their `×`: a
  chip's × is a known gesture and the composer's tag chips use it too.
- The composer Work in pill for a set ("Project folders") stays `FolderGit2`: its members
  can be of different kinds.
- Plugins' named icons (`components/plugin/icons.ts`) are a plugin API, not app concepts:
  unchanged.
- `react-refresh/only-export-components` forbids the map and hook beside the components,
  hence the `.ts` file; `GithubProjectMark` is its own file so the two do not import each
  other.
