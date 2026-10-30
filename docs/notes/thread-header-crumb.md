# Thread info card 3/5: header crumb and title menu, surfaces removed

Status: done on branch `cf/thread-header-crumb` (one PR, GUI plus the daemon's panel
verbs). The third of five PRs (1/5 `thread-info-facts.md`, 2/5 `thread-info-card.md`).
The thread header becomes `[crumb] › [title ▾]` with three toggles on the right, and every
side-panel surface the card replaces goes, with its entry points.

## The header

* **Left**: the crumb, then the title (`components/thread/ThreadParts.tsx`). The
  "Transcript deleted" chip stays after the title.
* **Crumb** (`lib/threadCrumb.ts`, pure, table-tested): no project → House, "No project";
  a workspace the store knows → Layers, its name (a thread in the workspace's folder too);
  several projects in no known workspace (a removed workspace included) → Folders,
  "<cwd project> +N"; one project → Folder, its name. Then the parent: the creator (an
  agent's thread) under its current name, a removed creator's recorded name as muted plain
  text; else the thread it was forked from (`Thread.parent_id`) while it exists (a fork
  records no name, so a removed fork parent leaves no segment). A click on the parent
  selects it, prompt focused. Each segment is followed by a `ChevronRight`, as the
  subagent view's crumb. The subagent view keeps its own header.
* The component reads the place as one string from the projects store (a status refresh
  elsewhere does not re-render it) and the parent shallowly from the threads store.
* **Title**: a button (name, muted `ChevronDown` always shown, `hover:bg-cf-control-hover`,
  pressed while open via `aria-expanded`, pointer cursor, `rounded-md`), a Radix dropdown
  trigger, so Enter and Space open it. It shrinks first (`shrink-[100]`, `min-w-12`): a long
  title truncates before the crumb does. A provisional name stays muted and italic.
* **Right**: `HeaderActions` is the three toggles only (thread info card, bottom panel,
  side panel).

## The title menu = the sidebar row's menu

* `components/thread/ThreadMenuItems.tsx` is the one item list; `menuKit.ts` holds the two
  kits (Radix context menu and dropdown parts: Item, Separator, Label, Sub, SubTrigger,
  SubContent) and `keepFocusAfterMenu` (Rename's inline input and New thread on this
  branch's composer keep focus when the menu closes). `RowMenu` renders it in the sidebar's
  `ContextMenuContent`, the title in a `DropdownMenuContent`.
* Order: Rename, Pin/Unpin, Snooze ▸ (Unsnooze while snoozed) | New thread on this branch,
  Save as workspace, Run in ▸, Hide from sidebar / Show in sidebar, Restart Claude, Clear
  flag | Archive/Unarchive. An item a thread cannot use is left out (the middle group and its
  divider go when empty: a no-project thread).
* Run in ▸ was not in the design's order; it sits in the middle group after Save as
  workspace (the brief lists it among the title menu's items).
* Hide/Show in sidebar: only for a thread another created (`useSidebarShown`), and only
  while `thread.sidebar` is listed. The sidebar row used to offer Hide only; it now offers
  Show too (for a hidden child opened elsewhere).
* Restart Claude (`thread.restart` with the thread's context): only while
  `Thread.plugin_env_stale`, and only while the command is listed.
* **The sidebar row keeps three items the title menu does not have**, after the shared
  list: New terminal here, Fork, Remove…. They were never in the header; the design's
  menu does not have them, and dropping them from the row would lose Remove and Fork from
  the mouse. Its **Show worktree** item is gone (it opened the removed Worktree surface).
* Shortcut hints in the sketch (↵, ⌘⌫) are not real chords (Rename is cmd+r, Archive has
  none), so the menu shows none, as the row menu did.

## Moved to the card

* **Flags and the plugin environment note** → the card's project row
  (`components/threadinfo/PlaceGroup.tsx`): a mark before its value (the worst flag's
  OctagonX/CircleAlert in its colour, else Plug) and a hover card listing each flag
  ("<plugin>: <reason>", red or amber) and "Plugin environment changed" with what changed
  (`lib/envStale.ts envStaleTip`). The header chip's × becomes the title menu's **Clear
  flag** (Clear flags with several), next to Restart Claude and shown only while the thread
  has flags: `thread.flag.clear` without `--plugin`, every plugin's flag. The command stays
  NoPalette, so this is its one GUI place; without it a stale flag would hold the thread in
  the attention group for good. The chip's click (open the plugin's surface) has no header
  place: a click on the sidebar row still opens it (`stores/flagSurface.ts
  openFlagSurface`). `useFlagSurfaceKind` and `clearThreadFlag` went with the chip.
* The env note's Restart → the title menu's Restart Claude.
* **Linked PRs** → the card's PR rows. The sidebar row's PR tag stays; its click now turns
  the card on (it opened the Linked PRs surface) and goes on to select the row.
* Snooze, Pin, Archive, Hide/Show in sidebar, New thread on this branch, Save as workspace,
  Rename, Run in → the title menu. The Actions play menu → the card's action row
  (`ThreadActionsMenu` and `ActionsMenu`'s header variant deleted).

## Surfaces removed

* **Usage** (`usage`, U), **Linked PRs** (`linkedprs`, L), **Threads** (`threads`, H),
  **Agents** (`agents`, A), **Worktree** (`worktree`, T) and its workspace-folder head (the
  v1 Workspace surface's successor). The global Usage sheet stays.
* **Changes** (new, `changes`, title "Changes", icon `Diff`, `surfaces/changes.ts`,
  `components/changes/ChangesView.tsx`): the Worktree tab's Changes and Commits lists only,
  no header, facts, operation strip, pull request row, Also in or Publish (the card has
  those). One tab per worktree (`{ project, path }`). Opened from the card's Changes row
  (titled "Changes"), its per-project sub-rows ("Changes · web") and the Projects page's
  project, worktree and workspace member rows (Enter, double-click, the row's overflow
  "Show changes"; into the page's panel; "Changes · web · cf/x" off the main worktree).
  Never listed in "+", no hotkey (`available` is "hidden", the PR surface's convention).
  A project without git says so (the Projects page's menu has Initialize git and Publish).
* **MCP** leaves "+" and loses M the same way; the card's MCP row and `view.panel.mcp` open it.
* "+" now lists Ember's Board (Ember only), File, Diff, Pull request, then plugins.
* `ui.focus.project` and a project just added used to open the project's overview on the
  Projects page; they now select the page with its cursor on the project's (or the
  worktree's) row (`stores/projectsPage.ts showProjectOnProjectsPage`).
* The strip above the composer shows background agent runs only: no shells sentence (the
  card's Shells group has them) and no "Agents ›" button. `backgroundLabel` takes the
  agent count only.

## Commands and verbs removed

* Daemon (`internal/command`): `view.panel.linked-prs`, `view.panel.usage`,
  `view.panel.threads`, `view.panel.worktree`, `view.panel.agents`; their ShowView names
  (`panel.linked-prs`, `panel.usage`, `panel.threads`, `panel.worktree`, `panel.agents`);
  the helpers they alone used (`withLinkedPRs`, `withAgentRuns`, `withLineage`,
  `inWorktreeOrFolder`, `inWorkspaceFolderContext`, `PanelThreads`). None had a default
  chord, and none was pinned in the palette, keybinding or read-only lists; the
  capabilities' panel group lists mcp, file, diff and pr (plus plugins).
* GUI: their presenters (`keys/bindings.ts`), window ShowView cases (`stores/views.ts`) and
  thread-scoped actions (`stores/threadPanelIntent.ts`); the panel letters U, L, H, A, T, M.
* Mock: the same five commands.
* Kept: `thread.snooze`, `thread.archive`, `thread.pin`, `thread.sidebar`,
  `thread.restart`, `thread.new-like`, `thread.workspace`, `thread.run-in`, `thread.agents`,
  `view.panel.mcp`/`file`/`diff`/`pr`/`toggle`/`expand`/`new-tab`/`split`. No header-only
  keybinding existed to remove.
* Agent-facing text: the help skill names `view.panel.mcp` where it named the worktree
  and usage verbs (6,871 bytes, under its line caps); the generated guide is 25,388 bytes
  (soft cap 25,500); `docs/ARCHITECTURE.md`'s side-panel paragraph.

## Deleted

`surfaces/{usage,linkedprs,threads,agents,worktree}.ts` and their targets and tests (the
part of `linkedprsTarget.ts` the sidebar and MCP use stays), `components/{linkedprs,lineage,agents}/`,
`components/usage/UsageSurface.tsx`, `components/overview/` (its `files.ts` and `shortRef`
moved to `components/changes/files.ts`), `stores/{usagePanel,linkedPrsPanel,threadsPanel,agentsPanel,worktreePanel,threadCheckouts}.ts`,
`lib/alsoIn.ts`, `components/thread/{ThreadMenu,FlagChip,EnvStaleNote}.tsx` and the
header's old tests, `SnoozeRowItems`/`SnoozeButton`, `agentsSubline`, `shellsLabel`,
`e2e/usage.spec.ts`, `e2e/worktree-panel.spec.ts`.

## Tests

* `lib/threadCrumb.test.ts`: one project, named workspace, workspace folder, unnamed set,
  removed workspace, agent's thread, removed creator, fork, removed fork parent, no project
  (and no project with a creator).
* `components/thread/ThreadMenuItems.test.tsx`: the order in both kits (the title's
  dropdown and the row's context menu, which adds its three), the cases that drop items,
  Show in sidebar, the thread.sidebar gate, Restart Claude, each item's command, Snooze's
  presets and dialog, Rename.
* `components/thread/ThreadParts.test.tsx`: the crumb per case, the parent's click,
  rename and removal, the title button, the three toggles.
* `components/changes/ChangesView.test.tsx`: the lists ported from the Worktree tab's tests.
* `e2e/thread-header.spec.ts` (mock scenarios `unnamed` and `home` added): the crumb for
  single, named, unnamed, no project and child (its parent opens); the title menu runs Pin
  and matches the row's menu; "+" without the removed surfaces; the card's Changes row
  opens the Changes tab and a file its Diff. `e2e/thread-info.spec.ts` follows the card's
  Changes rows to the Changes tab.

## Gotchas

* Editing `src/` while the e2e suite runs poisons the run: Vite hot-reloads half-edited
  modules into every page ("Importing binding name … is not found") and dozens of
  unrelated specs fail. Re-run clean before reading a failure list.
* Under a full parallel run the composer specs time out together (page.goto, a closed
  page) on this machine; they pass alone. `TestPollCacheRestart` (internal/store/gh,
  untouched here) failed once under `make check` load and passed 20 of 20 alone.
* A button in the header must say `[--wails-draggable:no-drag]` (the crumb's parent
  segment does), or the window drag takes its click; the crumb's place is text and drags.
* A Radix sub menu opens from the keyboard in jsdom with ArrowRight on its trigger.

## Verified

* `make check` green.
* e2e on WebKit: the full suite, then every spec this change touched re-run clean
  (thread-header, thread-info, actions, agents-panel, archive, buttons, composer-fixes,
  create, addproject(-workspace), app, file-tabs, layout, lineage, linkedprs, mcp-panel,
  no-project, nogit, panel, panel-split, plugin-env-restart, plugin-gaps, pr-panel, prs,
  project-sets, projects, snooze, subagent-view, threads, workspace-cards). The opt-in
  live specs were updated but not run.
* The built app (`make build`, `make gui-build`) on an isolated home
  (`CODE_FOUNDRY_HOME=/tmp/cf-hdr-shots`), scratch repos `web` and `api` with local bare
  remotes, workspace `platform`, Sonnet 5.5 medium, one-word prompts: a fresh-copy thread
  on `web` (crumb `web ›`, the title menu), a thread over `platform` (crumb `platform ›`,
  the card), a child made with `--created-by` (crumb `web › Fix the stale README badge ›`),
  the card's Changes row opening the Changes tab with the two changed files. Dark and
  light shots in the PR body. The daemon log had no warnings. The card toggle was on in
  the shared WebKit storage before and was left on; the panel opened for the check was
  closed again. Scratch repos, home and processes removed.
