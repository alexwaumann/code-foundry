# Thread header redesign

Decided 2026-10-13 (Alex, layout "A"). Design record: `docs/sketches/thread-header/`
(`index.html?h=a&s=wt|main|ws|merged|nogit` on top of the rendered-thread sketch, whose
style, icons and thread script it loads from `../rendered-thread/`; PNGs `a-*.png`).
Frontend only.

## What the header shows

Left to right:

1. **The thread's name** (13px, medium, foreground). A click runs `session.rename`
   through `CommandButton` (the same presenter as the palette: the inline editor in the
   sidebar row). The pencil button is gone. Ghost-button hover background, default cursor
   (the app never uses pointer cursors on buttons). Where `session.rename` is not listed
   the name is plain text.
2. **Where it runs**: `FolderGit2`, the project, a muted "@" (60% opacity), the branch in
   the mono font, and the shared `Chip` "worktree" when the cwd is a linked worktree. All
   from `threadRowModel` (the sidebar's model), so header and sidebar never disagree. A
   `CommandButton` for `view.panel.worktree` (the Worktree surface in the side panel) with
   a hover background; no tooltip (the label is visible). A project without git shows
   `Folder`, the project and the No git badge, with no "@" or branch.
3. **Right side**: the workspace chip (`view.panel.workspace`, `Layers` and the workspace's
   name; only for a workspace thread), linked PRs, Close (`session.close`, Power), the
   bottom panel toggle, the side panel toggle.
4. **Linked PRs**: one link shows that PR, its state icon and "#number" in the state's
   colour (open emerald `GitPullRequest`, merged violet `GitMerge`, closed red
   `GitPullRequestClosed`, draft muted `GitPullRequestDraft`, unknown/not loaded muted
   `GitPullRequest`); the state comes from `pullRequestDetailResource`, watched like a
   Linked PRs row. A click opens it as a tab of the thread's panel with
   `openPullRequestInPanel`, exactly what a Linked PRs row does (not a registry command;
   `openTab` shows the panel). Two or more: a muted `GitPullRequest` with the count,
   `view.panel.linked-prs` (unchanged). None: nothing.

Removed from the header: the status icon, the badge text, model · effort, the worktree
path, the pencil and fork buttons (`session.fork` stays in the palette). The
starting/closing `SessionIndicator` over the timeline stays.

**Sidebar line 2** reads "project @ branch" (same muted "@", mono branch); a status prefix
keeps its separator ("Working · project @ branch"). A project without git: "project
[No git]", no "@".

## Decisions and gotchas

* `CommandButton` gained `children` (custom content instead of icon + label; visible, so
  no title or aria-label) and `whenUnavailable="plain"` (the same content in a span with
  the same `className`, no hover). Unit-tested.
* **No-git threads keep a clickable location.** The brief assumed `view.panel.worktree`
  is unavailable for a no-git synthetic checkout. It is not: the daemon's
  `hasWorktreeThreadContext` only needs a repo and worktree, and the Worktree tab for a
  no-git project shows "Not a git repository" with Initialize Git
  (`worktree-panel-tab.md`). The location therefore follows the command's availability
  (plain text only where it is unlisted) and shows the no-git content either way. If the
  no-git location should not open anything, make it plain on `noGit` in `ThreadLocation`.
* **Chip**: the sidebar tooltip's chip (`bg-foreground/8`, no border) moved to
  `components/session/Chip.tsx` and is shared. The sketch drew a bordered chip; the
  shared filled one was kept so the tooltip and header match.
* **PR colours**: `components/prs/prState.ts` (`prStateLook`) is the one state → icon/tone
  mapping; `PrStateIcon` uses it with its 400 tones (an `unknown` state is now muted
  instead of emerald). The header uses the -600 tones in light mode for contrast.
* The name and location are buttons, so they no longer drag the window
  (`layout.spec.ts`); the empty header between them and the actions still drags and
  double-click-zooms. The name's button pulls its 6px hover padding into the header's
  (`-ml-1.5`), so its text starts where the header's padding (or the traffic-light gutter)
  ends.

## Rejected in the sketch

* **B**: the location as a bordered pill. **C**: the location right-aligned before the
  actions.
* A queued "moving to …" text in the header, a fork lineage link, and cost/context in the
  header.

## Test ids

* Unchanged: `thread-header`, `thread-title` (now the rename button, or a span),
  `pane-actions`, `pane-workspace` (now labelled with the workspace's name),
  `pane-linked-prs` (now only for two or more links).
* New: `thread-location` (button or span), `thread-project`, `thread-branch`,
  `thread-worktree-chip`, `pane-linked-pr` (one link; `data-state` open / draft / merged /
  closed / unknown).
* Removed: `session-badge-text`.

## Verification

* `make check` green; `make gui-e2e` (WebKit + Chromium) green.
* Unit tests: `CommandButton` (custom content, plain), `SessionParts` (name, location
  per checkout kind, plain when unavailable), `HeaderActions` (order, workspace chip, one
  PR per state, the count), `SidebarRow` (line 2), `prState`.
* Live (isolated `CODE_FOUNDRY_HOME`, two scratch projects under `$HOME` git-initialised
  with `repo.git.init`, a worktree thread and a `release-channels` workspace thread on
  haiku): `thread-header/live-worktree-{dark,light}.png`,
  `thread-header/live-workspace-{dark,light}.png`. A single linked PR was not arranged
  live (it needs Claude to create or mention a real PR); the mock e2e covers it
  (`linkedprs.spec.ts`, "one link").

Daemon restart: not needed (frontend only).
