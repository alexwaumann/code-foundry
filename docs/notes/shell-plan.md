# Shell build plan: spaces, panes and linked surfaces

Plan for building `docs/notes/shell-model.md` (the specification; it wins over this file) on the
`shell` branch. Written from a read of the repo at `c22382cda`, the in-app sketches
(`shell-sketches-2/`) and the behaviour toy (`shell-proto-6/index.html`). Nothing in the repo was
changed.

What I read in full: the spec, `CLAUDE.md`, `docs/ARCHITECTURE.md`, `gui/frontend/src/App.tsx`,
`stores/panel.ts`, `stores/bottomPanel.ts`, `stores/ui.ts`, `stores/views.ts`, `stores/intents.ts`,
`stores/threadPanelIntent.ts`, `stores/context.ts`, `keys/bindings.ts`, `surfaces/types.ts`,
`surfaces/registry.ts`, `components/thread/ThreadPane.tsx`, `internal/command/command.go`,
`chord.go`, `commands_view.go`, `commands_view_thread.go`, `intent.go`, `internal/termlabel`,
`proto/.../ui.proto`, and the toy's tree, layout, rails, placement, restore, swap, lifecycle and
history functions. What I only skimmed (names, sizes, exports, greps): the sidebar components,
`PendingPrompt.tsx`, `WaitingStrip.tsx`, `ThreadMenuItems.tsx`, the thread info card, `BottomPanel.tsx`,
`bottomActions.ts`, `TerminalHost.tsx`, the terminal and thread stores, `internal/api/events.go`,
`commands_terminal.go` (first 300 lines), the mock daemon, and the e2e and vitest suites. A worker
whose PR touches a skimmed file reads it first; where this plan states something about one, it says
"(not read)" if I did not verify it.

---

## 1. Findings

### 1.1 What owns what today

| Area | Files | Notes |
| --- | --- | --- |
| Window layout | `gui/frontend/src/App.tsx` | `Sidebar` + `ContentColumn(ContentPane(Content) + BottomPanel)` + `SidePanel`. `Content` switches on `useUiStore.selection`: thread, Pull Requests page, Projects page, Ember, composer. |
| Selection, focus regions, view history | `stores/ui.ts` | One `Selection` per window, not persisted (a window starts on HOME). `history`/`historyIndex` (50 entries) back `view.back`/`view.forward`. Focus is a region name (`sidebar/content/palette/panel/bottom`) plus `*FocusSeq` counters. 75 non-test files read the selection. |
| Side panel state | `stores/panel.ts` (1016 lines) | Per selection key (`thread:<id>`, `view:…`, `compose:…`): open, one or two tab groups, width, expanded, ratio, focused group. Persisted in **localStorage `code-foundry.panel`**, version 6, with five migrations and `sanitizePanelState`. 58 non-test files import it; `usePanelStore`/`getPanel` appear ~400 times. |
| Side panel components | `components/panel/*` | `SidePanel`, `TabGroup`, `TabStrip`, `GroupBody`, `PanelDnd` (dnd-kit), `dragDrop.ts`, `splitLayout.ts`, `keys.ts`, `announcements.ts`. |
| Surfaces | `surfaces/registry.ts`, `types.ts`, `files.ts`, `diff.ts`, `pullrequest.ts`, `mcp.ts`, `gallery.ts`, `ember.ts`, `plugin.ts` and the `*Target.ts` files | `SurfaceSpec` (kind, icon, available, render(tab), beforeClose, useUnsaved, waiting, onKey). Tab ids are derived from kind + params (`tabId`), which is today's identity rule. |
| Bottom panel | `stores/bottomPanel.ts`, `stores/bottomActions.ts`, `components/bottom/*` | Tabs are derived from the terminal list by owner labels; the store keeps only `open`, `height`, `activeTerminalId` per key, in **localStorage `code-foundry.bottom`**. Keys exist only for threads and `view:projects`. |
| Terminals | `internal/store/terminal`, `internal/termlabel`, `internal/daemon/shells.go`, `internal/command/commands_terminal.go`, `components/terminal/TerminalHost.tsx`, `src/terminal/*` | Every shell has an owner (thread, else worktree); `terminal.new` refuses a cwd outside every registered project. The reaper removes a shell when it exits or its owner goes. The store tracks OSC title, alt screen, the starting cwd; it can read the PTY's foreground group (`pty.go foregroundGroup`) but publishes neither a live cwd nor what runs. |
| Thread pane | `components/thread/ThreadPane.tsx`, `ThreadParts.tsx`, `HeaderActions.tsx`, `ThreadMenuItems.tsx` | `ThreadPane({threadId})` is already keyed by id and holds its `WatchThread` through `startThreadWatch` (holders are counted, so two views of one thread share a stream). |
| Thread info | `components/threadinfo/*`, `stores/threadInfo.ts`, `stores/threadInfoOverlay.ts`, `useInfoRoom.ts` | Card when the pane is wide, overlay when narrow: already what the spec asks. |
| Asks | `components/thread/PendingPrompt.tsx`, `WaitingStrip.tsx`, `DockStrip.tsx`, `lib/waiting.ts`, `stores/threads.ts` (`attentionIds`, `useAttentionCount`), EventService `thread` source (pending requests of every thread) | The data for "Needs you" already reaches the GUI for every thread without a per-thread stream. |
| Sidebar | `components/sidebar/*`, `lib/tree.ts` (`buildSections`, `threadOrder`), `lib/inSidebar.ts`, `lib/threadRow.ts` | Flat list (pinned, attention, done, idle) + footers Working, Snoozed, Archived. Pull Requests and Projects are rows. |
| Keys | `keys/bindings.ts`, `keys/chord.ts`, `internal/command/chord.go` (`ReservedChords`), `internal/command/keybindings_test.go`, `internal/store/settings/keybindings.go` | Chords come from `Command.Keybindings`; GUI-local `viewActions` own `cmd+k`, `cmd+b`, `cmd+shift+a`, `cmd+1..9`, zoom. `commandPresenters` replace a command's default presentation in the window. Users can override chords in `settings.toml`. |
| GUI steering | `internal/command/intent.go`, `commands_view*.go`, `commands_ui.go`, `proto ui.proto` (`UiIntent`), `internal/api/ui.go` | **The daemon holds no GUI state.** Every view verb is a `UiIntent` broadcast to all windows (`ShowView` name + `thread_id` + params, `FocusThread`, `FocusTerminal`). The model-facing verbs are `view.panel.file`, `.diff`, `.pr`, `.page`, `.gallery`, `.mcp`, `view.inline --panel`, `view.panel.toggle/expand/new-tab/split`, `view.bottom.toggle`, `thread.focus`, `ui.focus.terminal`, `plugin.<n>.show.<s>`. |
| Events | `proto events.proto`, `internal/api/events.go` (`sources()`), `stores/events.ts` (a registry), `api/events.ts` | One multiplexed stream with per-source snapshots and a numbered hub. `api/events.ts` drops an event kind it does not know, so a new source is safe for an older GUI. |
| DB | `internal/db/migrations/0001…0060` | Next file is `0061`. A database migrated by a newer build is refused (`db.ErrNewerSchema`). |
| Mock daemon | `gui/frontend/mock/world.ts` (5281 lines), `server.ts`, `panelVerbs.ts`, `panelItemVerbs.ts`, `shells.ts` | Re-declares commands and re-implements daemon behaviour in TypeScript. |
| Tests on the panels | e2e: `panel.spec.ts` (822), `panel-split.spec.ts`, `panel-split-drag.spec.ts`, `bottom-panel.spec.ts`, `terminal-routing.spec.ts`, `layout.spec.ts`, and ~27 more specs that use panel test ids (33 of 138). vitest: 36 test files touch `stores/panel`, `bottomPanel` or `bottomActions`. | |
| Guide and skills | `internal/skills/files/code-foundry/SKILL.md`, `code-foundry-help/SKILL.md`, `code-foundry-pages/SKILL.md` + `reference/verbs.md`, `welcome.md`, `code-foundry-plugin/reference/{nodes,ui-layout,manifest,owned}.md`, `docs/GETTING-STARTED.md`, tests `internal/skills/rules_test.go`, `verbs_test.go`, `internal/guide/*_test.go` | All mention the side panel or the bottom panel. |

### 1.2 Reused as is

- Surface bodies: `components/files/FileTab`, `components/diff/DiffView`, `components/pr/PullRequestSurface`,
  `components/mcp/McpSurface`, the gallery, `components/plugin/PluginSurface`, the Ember board, and the
  `*Target.ts` param codecs (`fileTab`, `diffTab`, `pullRequestTabId`, `galleryTab`). A tab keeps
  `{id, kind, title, params}`, so stored panel tabs carry over field for field.
- `ThreadPane` and everything under it (timeline, composer, find, cite, subagent view, `PaneOverlay`).
- `ThreadInfoCard`, `ThreadInfoOverlay`, `useInfoRoom`.
- `PendingPrompt` (the ask card, used unchanged in the popup and the hover card's permission buttons).
- `TerminalHost` and `src/terminal/*` (one Attach per mounted host).
- `PullRequestsPage`, `ProjectsPage` (they become surface bodies).
- `HistoryButtons` (moves into the top bar), `SidebarStatus`, the footers of the sidebar.
- shadcn `DropdownMenu` + submenus (the pane "+" menu and the three-dot menu), `Tip whenTruncated`.
- `@dnd-kit/core` and the collision and announcement helpers in `components/panel/dragDrop.ts` and
  `announcements.ts` as a starting point (they are rewritten for N panes, not reused verbatim).
- The command registry, the palette, `commandPresenters`, `lib/zoom.ts`, the design tokens.

### 1.3 Rewritten or removed

- `App.tsx` layout; `components/panel/*`; `components/bottom/*`; `stores/panel.ts` with its
  migrations; `stores/bottomPanel.ts`; `stores/bottomActions.ts`; `stores/threadPanelIntent.ts`; the
  panel and bottom parts of `stores/views.ts`; selection, history and focus-region parts of
  `stores/ui.ts`; `components/window/PaneHeader` use in panes; the thread header; the sidebar's
  sections and row layout; `lib/tree.ts` sections; the terminal ownership rules.
- Commands: `view.panel.toggle`, `view.panel.expand`, `view.panel.new-tab`, `view.panel.split`,
  `view.bottom.toggle` go. `view.pullrequests`, `view.projects`, `thread.previous`, `thread.next`,
  `thread.rename` lose their default chords.

### 1.4 What contradicts or complicates the specification

1. **Layout state is in WebKit localStorage, not in the daemon.** The first-load migration cannot
   be a SQL migration: the daemon cannot read `code-foundry.panel` or `code-foundry.bottom`. The GUI
   must hand them over once (section 3).
2. **Nothing records "the thread last viewed".** The selection is not persisted and the daemon has
   no last-viewed time. See open question 3.
3. **Placement needs pixels** ("room" is 480px; "nearest"; "next to"). The daemon must know the pane
   area's size, or placement cannot run for the CLI and for a model.
4. **Chord collisions with the old panels while both exist.** `cmd+j` (`view.bottom.toggle`),
   `cmd+shift+d` (`view.pullrequests`), `cmd+shift+j` (`view.projects`), `cmd+shift+[`/`]`
   (`thread.previous/next`), `cmd+r` (`thread.rename`), `cmd+w` (reserved) are all taken, and
   `TestKeybindingsAreUniqueAndNotReserved` forbids two commands on one chord. `ctrl+cmd+f` is the
   app menu's full screen; `ctrl+cmd+h/j/k/l`, `ctrl+cmd+arrows` and `ctrl+cmd+1..9` are free.
5. **Single-selection assumptions.** 75 files read `useUiStore.selection`, and the focus counters
   (`promptFocusSeq`, `contentFocusSeq`, …) ask "the" thread or "the" panel to take focus. With
   several panes, each needs a target.
6. **"New terminal linked to nothing, in the home directory"** contradicts today's rule that every
   shell has an owner inside a registered project (`canStartShell`, `shellOwner`, the reaper's
   owner checks).
7. **Terminal names, the cwd hint and "Run again"** need facts the terminal store does not publish:
   the shell's current directory, the foreground command, the last command.
8. **The toy and the spec disagree on placement** (open questions 1 and 5): the toy places by family
   (views to the right, terminals below, rule 2 per family) and never joins a pane that holds a
   thread tab; the spec has one rule set and "to the right".
9. **The mock daemon** re-implements daemon behaviour in TypeScript, so a daemon-side layout needs a
   mock counterpart (section 2.9).
10. **`workspace` is taken** (saved project sets, `internal/store/workspace`). The new store and its
    verbs use `layout`, `space`, `pane`, `tab`.
11. **Pins and the "done" band** exist today and the spec's sidebar sections do not mention them
    (open question 4).
12. **User keybinding overrides** in `settings.toml` may name retired commands or collide with new
    defaults; `resolveKeybindings` reports these as issues today (not read in full). The cutover PR
    checks what a stale override does.

---

## 2. Architecture

### 2.1 Principle

The daemon is the only writer of layout state. One pure Go package holds the model and every rule;
one store serialises mutations, persists them and publishes them; the GUI renders the published
layout and sends commands. The GUI decides only what depends on the rendered frame and is never
stored: rails, full screen, tab strip fitting, drag targets, DOM focus, the quick terminal's push or
overlay.

Why the rules are in the daemon, not the GUI:

- The CLI and a model must get the same result as a key press, with or without a window.
- Closing a thread, snoozing, archiving, restoring and moving between spaces start from daemon
  events (a snooze from the CLI must still close linked tabs and keep the set).
- One implementation, table-tested in Go (the repo's rule: daemon rules are tested in Go, not
  through the mock).
- A loopback round trip is a few milliseconds; only two trivial changes are applied optimistically
  (2.6).

### 2.2 Packages and files

```
internal/layout/                 pure, no I/O, no store imports
  model.go        State, Space, Node (Pane | Split), Tab, ThreadState, ids
  decode.go       JSON <-> model, version upgrade, sanitise, normalise
  rects.go        Rects(tree, W, H): the plain proportional layout (no rails), Adjacent, SideNeighbours
  ops_tree.go     AddTab, SplitPane, MoveTab, MovePane, MergePane, CloseTab, ClosePane, SetSizes, Focus
  ops_space.go    NewSpace, RenameSpace, RemoveSpace, ReorderSpaces, SwitchSpace
  identity.go     Kinds: the surface kind registry (key function, linked?, default size, renameable)
  place.go        Place (rules 1-6), ThreadTarget
  thread.go       OpenThread, CloseThread (remember), Restore, MoveThreadToSpace, Archive, Snooze
  swap.go         SmartSwap
  legacy.go       ImportLegacy (section 3)
  testdata/       shared JSON fixtures (also read by vitest)
internal/store/layout/           Manager: SQLite, snapshot, bus events; layouttest/ fake
internal/api/layout.go           LayoutService handler (thin)
internal/api/layout_events.go    the `layout` event source
internal/daemon/layout.go        glue: thread and terminal events -> layout ops; presence -> viewport
internal/command/commands_space.go, commands_pane.go, commands_tab.go, commands_layout.go,
                 commands_thread_open.go, commands_view_open.go, commands_terminal_quick.go
proto/codefoundry/v1/layout.proto
```

`internal/store/layout` imports `internal/layout`, `internal/bus`, `database/sql`. It never imports
the thread or terminal stores: `internal/daemon/layout.go` adapts their events, as
`plugin_hooks.go` does for plugins.

### 2.3 Data model

Migration `internal/db/migrations/0061_layout.sql`:

```sql
CREATE TABLE layout_spaces (
    id         TEXT PRIMARY KEY,          -- "sp-" + 8 chars
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL,
    doc        TEXT NOT NULL,             -- JSON, see SpaceDoc
    updated_at INTEGER NOT NULL           -- unix ms
);
CREATE TABLE layout_threads (
    thread_id  TEXT PRIMARY KEY,          -- no foreign key: the thread store owns `threads`
    space_id   TEXT NOT NULL,
    doc        TEXT NOT NULL DEFAULT '{}',-- JSON, see ThreadDoc
    updated_at INTEGER NOT NULL
);
CREATE TABLE layout_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: rev, current_space, legacy_import ("" | "done:<unix ms>")
```

The SQL creates empty tables only. At open, a store with no space makes one named "Main". A thread
without a `layout_threads` row belongs to the first space (by `position`); the row is written when
something about it must be stored. So every existing thread is in the one space with no data
migration, and a thread made by a path the glue missed still has a space.

```jsonc
// SpaceDoc
{ "v": 1,
  "root": Node | null,
  "focus": "p-3",                      // the focused pane
  "mru": ["t-9", "t-2"] }              // tab ids, most recently focused first, at most 64
// Node
{ "t": "pane",  "id": "p-3", "tabs": [Tab], "active": "t-9" }
{ "t": "split", "id": "s-1", "dir": "row" | "col", "kids": [Node], "sizes": [0.6, 0.4] }
// Tab
{ "id": "t-9",
  "kind": "thread" | "diff" | "file" | "pullrequest" | "terminal" | "prs" | "projects"
        | "compose" | "mcp" | "gallery" | "ember.board" | "plugin.<plugin>.<surface>",
  "thread": "s-…",                     // the link; "" for an unlinked tab; the thread itself for kind thread
  "key": "…",                          // identity key from the kind registry; "" = never deduplicated
  "params": { "…": "…" },              // what it shows and its own view state (today's Tab.params)
  "title": "…",                        // last automatic title, for strips and the CLI
  "name": "…" }                        // manual name (terminals); "" = automatic
// ThreadDoc
{ "v": 1,
  "quick": { "open": false, "height": 200 },
  "remembered": { "pane": "p-3",       // the pane the thread's tab was in when it closed
                  "tabs": [ { "tab": Tab, "pane": "p-7", "index": 1, "active": true,
                              "adjacent": true,
                              "beside": { "neighbours": ["p-3"], "edge": "right", "frac": 0.45 } | null,
                              "fresh": { "name": "", "ran": "make dev" } | null } ] } | null,
  "last": { "diff": "t-9" } }          // per kind, this thread's tab last active (smart swap picks it)
```

Normal form, kept after every op (the toy's `norm`): no pane without tabs, no split with one child,
no split nested in a split of the same direction, sizes positive and summing to 1, `active` and
`focus` naming something that exists, `mru` holding only live tab ids. Ids are random (`p-`, `s-`,
`t-`, `sp-` plus 8 base32 characters); a remembered pane is put back under its old id.

Constraints the model enforces: a tab id is in at most one pane of one space; a thread has at most
one `thread` tab in total (it lives in exactly one space); a terminal id is in at most one tab in
total; `prs` and `projects` are one per space (their key is the kind).

**Versioning.** `v` in each doc. `decode.go` upgrades an older `v` and repairs any shape into normal
form, the lesson of `sanitizePanelState`. Only the daemon reads these rows, and `db.ErrNewerSchema`
already refuses a downgrade.

**Ordering of concurrent edits.** `Manager` holds one mutex (as `workspace.Manager`). A mutation is
one call: read state, run a pure op, normalise, write the changed rows and `rev + 1` in one
transaction, swap the snapshot, publish one event. So edits from the GUI, the CLI and a model are
ordered by arrival at the mutex, and every client sees the same sequence of `rev`s. Ops name stable
ids (tab, pane, split, space) and are validated against the current state: an op whose id is gone
fails with `NotFound` and changes nothing. There is no compare-and-swap and no merge: two writers
only conflict on plain values (sizes, a name), where the later one wins. Focus-only changes (`focus`,
`active`, `mru`) are written through at most once a second and at shutdown; structural changes are
written at once.

### 2.4 Proto and stream

`proto/codefoundry/v1/layout.proto` (owned by `LayoutService`), plus `EVENT_SOURCE_LAYOUT = 19` and
`LayoutEvent layout = 22` in `events.proto`:

```proto
service LayoutService {
  rpc Get(GetLayoutRequest) returns (GetLayoutResponse) {}            // the whole Layout
  rpc Apply(ApplyLayoutRequest) returns (ApplyLayoutResponse) {}      // one LayoutOp
  rpc SetViewport(SetViewportRequest) returns (SetViewportResponse) {}
  rpc ImportLegacy(ImportLegacyRequest) returns (ImportLegacyResponse) {}
}
message Layout {
  uint64 rev = 1;
  repeated Space spaces = 2;            // in position order
  string current_space_id = 3;
  repeated ThreadLayout threads = 4;    // only threads with a row
  bool legacy_imported = 5;
}
message Space { string id = 1; string name = 2; LayoutNode root = 3; string focus_pane_id = 4; repeated string mru_tab_ids = 5; }
message LayoutNode { oneof node { Pane pane = 1; Split split = 2; } }
message Pane  { string id = 1; repeated Tab tabs = 2; string active_tab_id = 3; }
message Split { string id = 1; Direction dir = 2; repeated LayoutNode children = 3; repeated double sizes = 4; }
message Tab   { string id = 1; string kind = 2; string thread_id = 3; string key = 4;
                map<string, string> params = 5; string title = 6; string name = 7; }
message ThreadLayout { string thread_id = 1; string space_id = 2; QuickTerminal quick = 3;
                       repeated RememberedTab remembered = 4; string remembered_pane_id = 5; }
message LayoutEvent {
  uint64 rev = 1;
  oneof change { Layout snapshot = 2; LayoutDelta delta = 3; }
  FocusRequest focus = 4;               // "move the keyboard to this tab now", set by ops that ask
  string client_id = 5;                 // the client whose call caused it, "" for the daemon's own
}
message LayoutDelta {                    // everything one commit changed, applied as one step
  repeated Space spaces = 1; repeated string removed_space_ids = 2;
  repeated string space_order = 3; string current_space_id = 4;
  repeated ThreadLayout threads = 5; repeated string removed_thread_ids = 6;
}
message ApplyLayoutRequest  { LayoutOp op = 1; string client_id = 2; }
message ApplyLayoutResponse { uint64 rev = 1; string tab_id = 2; string pane_id = 3; string space_id = 4;
                              string rule = 5; }   // rule: "1".."6", "restored", "thread-closed", … for the CLI
message LayoutOp { oneof op {
  OpenThread open_thread = 1;  CloseThread close_thread = 2;  OpenSurface open_surface = 3;
  FocusTab focus_tab = 4;      CloseTab close_tab = 5;        ClosePane close_pane = 6;
  MoveTab move_tab = 7;        MovePane move_pane = 8;        SetSizes set_sizes = 9;
  FocusPane focus_pane = 10;   SwapPane swap_pane = 11;       SetTabParams set_tab_params = 12;
  RenameTab rename_tab = 13;   NewSpace new_space = 14;       RenameSpace rename_space = 15;
  RemoveSpace remove_space = 16; ReorderSpaces reorder_spaces = 17; SwitchSpace switch_space = 18;
  MoveThreadToSpace move_thread = 19; SetQuick set_quick = 20; CycleTerminals cycle_terminals = 21;
} }
```

A delta carries whole spaces (a space is a few kilobytes) and whole thread records, never a patch of
a tree. The source's snapshot is one `LayoutEvent{snapshot}`; live events are deltas; a client that
missed events gets the snapshot again through the hub's existing resync. `code-foundry events
--source layout` and plugins read the same source.

`SetViewport{client_id, width, height}` is the pane area in layout px (viewport px divided by the
page zoom). The store keeps the last one from a GUI client that is visible; with none it uses
1180 x 820. The daemon uses it only for `Rects` in placement, restore and direction verbs.

### 2.5 Where each rule lives

| Rule | Lives in | Why |
| --- | --- | --- |
| Tree ops, normalisation | `internal/layout/ops_tree.go` | every edit goes through the store |
| Placement (rules 1-6), where a thread tab lands | `internal/layout/place.go` | CLI, model and keys must agree; needs `Rects` and the viewport |
| Identity | `internal/layout/identity.go` | rule 1 and restore need the key |
| Smart swap | `internal/layout/swap.go`, run inside `FocusTab`/`OpenThread` when the tab that gains focus is a thread tab and `layout.smart_swap` is on | must also run for a focus the CLI caused |
| Close with the thread, remember, restore | `internal/layout/thread.go` | started by daemon events as well as by `cmd+w` |
| Move to space, archive, snooze effects | `internal/layout/thread.go` + `internal/daemon/layout.go` | start from thread store events |
| "Focus returns to what had it before" | `CloseTab`: the newest `mru` entry still open in the same space, else the pane's neighbour tab | part of the same commit as the close |
| Rails | GUI, `src/shell/geometry/rails.ts` | derived per frame from the window size; the stored layout does not change |
| Full screen, the floating composer | GUI, `src/stores/shellView.ts` (window state, not persisted) | spec: pane focus and move keys do nothing while it is on; nothing stored |
| Rendered rectangles with minimums | GUI, `src/shell/geometry/rects.ts` | the daemon's `Rects` is the plain layout only; the two are pinned to shared fixtures |
| Drag targets and previews | GUI, `src/shell/drag/targets.ts`; a drop is one `tab.move` or `pane.move` | hit-testing is pixels on screen |
| Tab strip fitting (shorten, icon-only) | GUI, `src/shell/geometry/tabFit.ts` | measured text |
| Back and forward (`cmd+[`, `cmd+]`) | GUI, `src/stores/focusHistory.ts`, moving with `tab.focus` / `space.switch` | per window and not persisted, as today's `history`; ported from the toy's `pushLoc`/`navHist` |
| Quick terminal push or overlay | GUI, in the thread pane | depends on the pane's height |

### 2.6 Focus

- **Stored focus**: per space `focus` (pane) and per pane `active` (tab); `current_space_id`; `mru`.
  This is what "the focused tab" means to the daemon, to the CLI and to placement ("the focused
  pane").
- **DOM focus** stays the GUI's. A `LayoutEvent.focus` asks the window to move the keyboard into a
  tab (its surface's focus root, a thread's prompt, a terminal). The GUI's `focusin` handler reports
  a pane taking the keyboard with `pane.focus --pane`.
- **Optimistic**: `tab.focus` and `pane.focus` set `focus`/`active` in the GUI's layout store at
  once and are confirmed or corrected by the next event. Nothing else is applied before the daemon
  answers.
- **A call from inside a thread never moves the user's focus**: an op from a thread's CLI
  (`CallerThreadID` set, `ActiveView` empty) or a page runs with `Focus: false` unless `--focus`,
  as the thread-scoped panel verbs do today. Its tab becomes active in its pane unless that pane is
  the focused one; there it joins behind the active tab and its strip icon shows the waiting mark
  (`SurfaceSpec.waiting` exists for this).
- The focus-region model (`FocusRegion`, `*FocusSeq`) is replaced by `{region: "sidebar" | "palette" |
  "pane", paneId}` in `src/stores/shellView.ts`; the palette returns focus to the pane it came from.

### 2.7 Surface identity: a registry on each side

Go, `internal/layout/identity.go` (a map, one entry per kind; plugin kinds match by prefix):

| Kind | Linked to a thread | Key (two tabs with the same key in one space are the same tab) |
| --- | --- | --- |
| `thread` | itself | `thread:<id>` (one in total, not per space) |
| `diff` | yes, or unlinked from a Projects page row | `diff:<thread>:<project>:<worktree>`; a thread's titled tab of its own (`--title`): plus `:<title>` |
| `file` | yes, or unlinked | `file:<absolute path>` |
| `pullrequest` | yes, or unlinked | `pr:<owner/repo lower case>#<n>` |
| `terminal` | yes, or unlinked (free) | `term:<terminal id>` (so "New terminal" always makes a new tab) |
| `prs`, `projects` | no | the kind |
| `compose` | no | `compose:<project or workspace or like or home>` |
| `mcp` | yes | `mcp:<thread>` |
| `gallery` | yes | `gallery:<thread>:<title>` |
| `ember.board` | Ember's thread | the kind |
| `plugin.<p>.<s>` | by the surface's scope | `plugin:<p>/<s>/<scope value>` |

The quick terminal is not a tab: it is `ThreadDoc.quick` plus the thread's terminal labelled
`slot=quick` (2.10), one per thread by construction.

TypeScript, `gui/frontend/src/shell/surfaces/registry.ts`: one `ShellSurface` per kind (a file each
under `src/shell/surfaces/`), wrapping today's `SurfaceSpec` where one exists: `icon`, `title(tab)`,
`render(tab, host)`, `linkedRow(tab)` (the quiet row: "Diff of ● thread", the cwd hint for
terminals), `renameable`, `defaultSize`, `beforeClose`, `useUnsaved`, `waiting`. A test compares its
kinds with a list exported from Go (`internal/layout/testdata/kinds.json`), so the two registries
cannot drift.

### 2.8 Commands

All in `internal/command`, each calling `LayoutService.Apply` through a `LayoutBackend` interface in
the generated Connect signatures (the pattern of `TerminalBackend`). "Chord" is the default from the
spec's key table; chords enter the registry only at cutover (2.11). Verbs that take ids accept a
unique suffix (`IDKind`), with new id kinds `TabID`, `PaneID`, `SpaceID`.

User-facing:

| Command | Chord | Does |
| --- | --- | --- |
| `thread.new` (exists) | `cmd+n` | opens a `compose` tab (the composer invokes it) |
| `thread.open <id>` | — | sidebar click: focus its tab, or add one (restore its set). `thread.focus` becomes the same verb with `--focus` |
| `thread.close [<id>]` | — | closes the thread's tab from its space; linked tabs close and are remembered |
| `thread.space.move <id> --space` | — | Move to space |
| `tab.close [<tab>]` | `cmd+w` | a thread tab is `thread.close`; focus returns to what had it before |
| `pane.close [<pane>]` | `cmd+shift+w` | each thread in it closes as a thread does |
| `tab.next`, `tab.previous` | `cmd+shift+]`, `cmd+shift+[` | within the pane |
| `pane.focus.left/.down/.up/.right` | `ctrl+cmd+h/j/k/l` and `ctrl+cmd+arrows` | the GUI's presenter resolves the neighbour from the rendered frame and passes `--pane`; the CLI's uses `Rects` |
| `pane.move.left/.down/.up/.right` | the same with `shift` | swaps with that neighbour |
| `pane.fullscreen` | `cmd+shift+enter` (`escape` leaves) | window state; a `ShowView` for the CLI, as `view.thread-info` |
| `space.switch --index n \| <space>` | `ctrl+cmd+1…9` | the nine chords are GUI `viewActions` that invoke it with `--index` (a chord cannot carry an argument); they join `ReservedChords` |
| `space.new`, `space.rename`, `space.remove`, `space.move` | — | top bar "+", the space tab's menu, drag to reorder |
| `terminal.new` (exists, changed) | `cmd+t` | a new shell linked to the current thread, as a tab placed by the rules |
| `terminal.new-free` | `cmd+shift+t` | a shell linked to nothing, in the home directory, as a tab in the focused pane |
| `terminal.quick [--thread]` | `cmd+j` | the quick terminal: open and focus, focus when open, close when focused (the presenter decides the middle case from DOM focus); from a linked surface, go to its thread and open it |
| `terminal.cycle` | `cmd+shift+j` | the ring: thread, each of its terminal tabs in layout order, thread; from a view it starts at the first terminal |
| `terminal.reset`, `terminal.rerun` | — | the hint's Reset; "Run again" |
| `view.open.diff` | `cmd+shift+d` | the thread's diff; from that diff, back to the thread |
| `view.thread-info` (exists) | `cmd+shift+i` | unchanged |
| `file.find` (exists) | `cmd+p` | the result opens as a tab (`view.open.file`) |
| `tab.rename [<tab>]` | `cmd+r` | a thread tab renames the thread (inline in the tab); a terminal tab sets its manual name; others refuse |
| `tab.auto-name [<tab>]` | `cmd+shift+r` | a thread: `thread.regenerate-name`; a terminal: back to its automatic name |
| `view.open.prs`, `view.open.projects` | — | palette and "+"; one per space, focused when open |
| `view.back`, `view.forward` (exist) | `cmd+[`, `cmd+]` | presenters step the window's focus history |
| GUI `viewActions` (unchanged kind) | `cmd+k`, `cmd+b`, `cmd+1…9`, `cmd+shift+a` | palette; sidebar; nth thread of the list (now `thread.open`); the popup of the next thread that needs the user |

For direct manipulation and the CLI (`NoPalette`, no chord): `tab.focus <tab>`,
`tab.move <tab> (--pane <p> [--index n] | --split <p> --edge left|right|top|bottom | --space <sp> |
--outer left|right|top|bottom)`, `pane.move <pane> (--beside <p> --edge e | --into <p> [--index n] |
--outer e | --space <sp>)`, `pane.resize --split <s> --sizes 0.6,0.4`, `pane.focus --pane <p>`.

Read-only, for the CLI and a model: `layout.show [--space] [--json]` (spaces, the pane tree as an
indented outline with pane and tab ids, kinds, links, the focused tab), `space.list`, `tab.list
[--thread]`.

A model arranges a layout with the same verbs. From inside a thread they need explicit ids (no
"focused" default: the user's focus is not the model's to act on) and never take focus without
`--focus`.

### 2.9 Today's model-facing verbs

| Today | In the shell | Guide and skills must say |
| --- | --- | --- |
| `view.panel.file`, `view.panel.page`, `view.panel.diff`, `view.panel.pr`, `view.panel.gallery`, `view.panel.mcp` | Canonical names `view.open.file`, `.page`, `.diff`, `.pr`, `.gallery`, `.mcp`, same args and checks. The tab is linked to the thread and placed by the rules; `--focus` also focuses it. The old names stay registered as `NoIndex` + `NoPalette` aliases (the same `Run`) for threads and pages that already know them (open question 7). | "opens a tab beside your thread; it never takes the user's focus; `--focus` only when the user asked" |
| `view.inline --panel` | unchanged; `--panel` is `view.open.page` | "also open it as a tab" |
| `view.panel.toggle`, `.expand`, `.new-tab`, `.split`, `view.bottom.toggle` | removed (`refactor(command)!`). There is nothing to toggle; arranging is `tab.move`, `pane.move`, `pane.resize`. | drop them; add the `layout` topic |
| `thread.focus` | `thread.open --focus`: switches to the thread's space and focuses its tab. Works with no window (it shows when one opens). | "takes the user there; only when asked" |
| `ui.focus.terminal` | focuses the terminal's tab, opening it by the rules; the quick terminal opens in its thread | same sentence |
| `terminal.new` from a thread | the shell gets a linked tab placed by the rules, not focused | "your shells show as tabs beside the thread" |
| `view.pullrequests`, `view.projects` | open or focus the surface in the current space (still refused from a thread no window shows, without `--focus`) | "a tab, not a page" |
| `plugin.<n>.show.<s>` | opens the plugin surface as a tab; thread-scoped ones are linked | plugin skill: "side panel" becomes "a tab"; `ui-layout.md` widths no longer assume a 420px panel |
| `thread.agent.open`, `thread.agent.up` | unchanged: the run shows inside the thread's tab | — |
| `ui.presence` | unchanged; "a window shows its thread" is still "it has a `WatchThread` subscriber" | — |
| new: `layout.show`, `tab.*`, `pane.*`, `space.*` | — | a new guide topic `layout`: read with `layout.show`, never move the user's focus, prefer `view.open.*` and let placement work |

Until cutover the item verbs do both: apply the layout op and emit today's `ShowView`, so the classic
window keeps working. The shell ignores `panel.*` `ShowView`s.

### 2.10 Terminals

- `internal/termlabel`: `Free()` labels (kind `shell`, no thread, project or worktree) and a `slot`
  label with value `quick`. `terminal.new-free` starts `$SHELL` in the home directory. The reaper
  (`internal/daemon/shells.go`) treats an ownerless shell as owned by its tab: it is removed when it
  exits or when no tab holds it (daemon glue on layout events), never by a project or thread check.
- `internal/store/terminal`: three published facts on `Terminal` (proto fields `live_cwd`,
  `foreground`, `last_command`), refreshed when output goes quiet (debounced like the title) and
  when the foreground group changes: the shell's current directory (from its pid), the foreground
  job's command when it is not the shell, and the last such command once it has ended. Reading them
  stays inside the terminal's actor or a helper it calls; the store stays program-agnostic.
- Names (GUI, pure `lib/terminalName.ts`): the manual name, else the foreground command with an icon
  by a small table (the toy's `shellIcon`), else `<shell> · <folder>`.
- The cwd hint: `live_cwd` differs from the thread's directory. Reset is `terminal.reset`: close the
  shell and start a fresh one in the thread's directory under the same tab (or quick slot).
- Snooze and archive already remove the thread's shells (`thread/shells.go removeShells`). Before a
  snooze removes them, the glue records each terminal tab's `fresh{name, ran}` in the remembered set;
  restoring creates a new shell per record and the tab shows the idle name with one line "last
  command … Run again". Nothing reruns by itself.

### 2.11 Coexistence during the build, and the cutover

- The new window is `components/shell/Shell.tsx`, mounted by `App.tsx` in place of the classic
  layout when the shell flag is on. The flag is `localStorage["code-foundry.shell"] === "1"` or
  `?shell=1` (e2e and `make drive`), default **off** until cutover. Classic and shell share every
  domain store (threads, terminals, projects, gh, settings).
- **A host seam** decouples the 58 importers of `stores/panel.ts`: `src/shell/host.ts` exports the
  tab operations surfaces use (`openTab`, `closeTab`, `setTabParams`, `retitleTab`, `replaceTab`,
  `findTabs`, `useTab`, targets `thread:<id>`, `pane:<id>`, `current`). With the flag off it
  delegates to `stores/panel.ts`; with it on, to the layout client. Surface code imports the seam,
  never the panel store.
- **A selection bridge** keeps the 75 readers of `useUiStore.selection` working: with the flag on,
  `src/stores/selectionBridge.ts` writes the selection from the focused tab (a thread tab or a
  linked tab: that thread; `prs`/`projects`: the page; `compose`: the composer) and routes
  `ui.select(...)` to `thread.open` / `view.open.*`. `getUiContext` therefore keeps answering "the
  current thread" (the spec's meaning in `cmd+t`).
- **Keys**: new commands register without default chords. With the flag on, `src/shell/keys.ts` maps
  the spec's table onto them ahead of the registry's bindings. At cutover the chords move into
  `Command.Keybindings`, the retired chords go, and the table is deleted.
- **Daemon**: the layout store, service, event source and commands are additive. The classic window
  ignores them. Item verbs emit both forms (2.9).
- **Cutover** is PR 20: the flag's default flips and the import runs. **The old side panel, bottom
  panel and their stores are removed in PR 21**, the daemon's legacy intents and the seam's classic
  half in PR 22.

### 2.12 GUI and daemon at different versions

`shell` is never released, so the windows that matter are (a) a worker's or the owner's GUI against
an older daemon still running from the same branch, and (b) users after the final merge.

- New GUI, old daemon, before cutover: the flag is off, nothing changes. With the flag on and no
  `layout` snapshot within the first events, the window stays classic and says so once.
- New GUI, old daemon, after cutover (every user during an update): the shell cannot draw without
  the layout source. `lib/update.ts` gets `SHELL_SINCE` beside `TUNNEL_SINCE`; a daemon before it
  opens the update dialog with Restart Now, exactly as a pre-tunnel daemon does. No fallback.
- Old GUI, new daemon (the daemon restarted alone): the old window keeps its localStorage panels and
  works as before. After PR 22 a model's `view.open.*` changes the daemon's layout but shows nothing
  in that window until it restarts; `terminal.new` still shows in its bottom panel. The import does
  not run until a new GUI connects; ops applied before it are merged, not overwritten (section 3).

Each PR's own behaviour in that window is stated in section 4.

### 2.13 Frontend state shape

`src/api/layout.ts` maps the proto to view models (the only file that imports the generated types).
`src/stores/layout.ts` is the slice the `layout` source feeds: `spaces` (ids in order, current),
`trees` (per space: structure only, ids, directions, sizes), `panes` (by id: tab ids, active),
`tabs` (by id), `threads` (by id). Applying a delta keeps the object identity of every pane and tab
that did not change, so `usePane(id)`, `useTab(id)` and `useTree(spaceId)` re-render one thing.
No component subscribes to the whole slice.

Streams: a pane mounts only its active tab's body; a pane folded to a rail mounts none; in full
screen only that pane is mounted. So one `WatchThread` per thread on screen (shared with the
Needs-you popup when it shows the same thread), one `Attach` per terminal on screen (a terminal is
in one tab; the quick terminal is attached only while open under its thread's active tab), and a
hidden tab holds nothing.

### 2.14 The mock daemon

`gui/frontend/mock/layout.ts`: the layout source, `LayoutService`, and the mechanical ops only (add,
move, split, close, focus, sizes, spaces), with seeds that give e2e an arbitrary tree. It does not
port placement, restore or swap: a linked open in the mock is "focus if open, else a tab in the
first pane that holds this thread's linked tabs, else a new pane to the right". The rules are tested
in Go; the browser tests seed the tree they need. The mechanical ops are pinned to the same JSON
cases as the Go ops (`internal/layout/testdata/ops/*.json`, read by vitest the way
`lib/cfBridgeScript.test.ts` reads `internal/bridge/bridge.js`).

---

## 3. The first-load migration

Trigger: the first shell-default GUI (PR 20 or later) that connects to a daemon whose
`legacy_import` is unset. The GUI calls `LayoutService.ImportLegacy` once, before it draws the shell,
with:

- `panel_json`: the raw value of `localStorage["code-foundry.panel"]` (any version; may be absent);
- `bottom_json`: the raw value of `localStorage["code-foundry.bottom"]`;
- `last_thread_id`: see open question 3;
- `thread_info_open`, from `code-foundry.ui`.

The daemon does the rest in `internal/layout/legacy.go` (pure; inputs: those values, the thread list
with archive and snooze state, the terminal list with labels and start times, the viewport):

1. Parse and repair the panel store with a Go port of `sanitizePanelState` and migrations V1-V5
   (the port is pinned to the TypeScript one by fixtures captured from `panel.migrate.test.ts`).
   Entries for keys other than `thread:<id>` are dropped (pages and composers had their own panels;
   the spec keeps only threads' sets).
2. For each thread with an entry, in the order group 0 then group 1: each tab becomes a linked tab
   `{kind, thread, key, params, title}`. Kinds map one to one (`file`, `diff`, `pullrequest`, `mcp`,
   `gallery`, `plugin.*`); a kind the registry does not know is dropped. `open`, `width`,
   `expanded`, `ratio`, `pickFrom` are not carried over.
3. For each thread, its terminals by owner label (`thread`), running ones only, oldest first: the
   first shell (`kind=shell`) gets `slot=quick` and becomes the thread's quick terminal, with
   `quick.open` and `quick.height` from the bottom store's entry; every other terminal (later shells,
   action runs, setups) becomes a linked `terminal` tab. No process is touched: relabelling is
   metadata.
4. The last-viewed thread, if it exists, is not archived and not snoozed: `OpenThread` in the one
   space, then its linked tabs in stored order and its terminal tabs, each through `Place`. So they
   land "by the rules": the first makes a pane to the right when there is room, the rest join it.
5. Every other thread: its tabs become its remembered set with no pane (`remembered.pane = ""`), so
   opening it later places them fresh beside it. Its terminals keep running.
6. Worktree-owned shells (the Projects page's bottom panel) have no thread: they stay running and
   are listed under the Projects surface's "+" as unlinked terminals; none is opened.
7. Set `legacy_import = done:<now>` in the same transaction. A second call is a no-op that answers
   the current layout.

If the layout is not empty when the import runs (a model's verb ran against the new daemon before
any new GUI connected), nothing is replaced: step 4 is skipped when the space has panes, and each
thread's legacy tabs are added to its remembered set unless a tab with the same key is already open
or remembered.

The GUI leaves both localStorage keys in place until PR 21 has been on `main` for a release (a
downgraded window still finds them), then a later change removes them. A fresh install sends empty
values and gets "Main" with no panes, which draws the home composer.

Tests: a table over captured stores (v2 flat tabs, v6 split, a store another build wrote with `{}`
groups, absent, garbage), threads with zero, one and three terminals, an archived last thread, and
the not-empty case.

---

## 4. The PR stack

Rules for every PR: branch from `shell`, target `shell`; `make check` green; a note
`docs/notes/shell-<n>-<slug>.md` (text only); the end-to-end check on a scratch home
(`CODE_FOUNDRY_HOME=$(mktemp -d)` with `make build` and the CLI, or `make drive DAEMON=dev`
for the GUI); UI PRs attach dark and light screenshots and list every difference from the sketches;
`make gui-build` at the end of a GUI PR. Sizes: S under ~300 changed lines, M ~300-900, L more.

```
1 ─┬─ 2 ─┐
   ├─ 3 ─┼─ 4 ─┬─ 6 ─┬─ 7
   │     │     │     └─ 18
5 ─┼─────┘     │
8 ─┤ (GUI seam, from the start)
   └─ 9 (needs 1) ─┐
        10 (needs 3) ─ 11 ─┬─ 12 ─┐
                           ├─ 13 ─┼─ M1 ─ 15 (M2) ─ 16 ─ 17 (M3)
                           └─ 14 ─┘       19 (M4)
                                          20 ─ 21 ─ 22 ─ 23 ─ 24 ─ 25 (shell -> main)
```

### PR 1 — `feat(layout): the layout model, tree operations and plain rectangles`

- **Goal**: the pure core every later PR stands on.
- **Adds**: `internal/layout/model.go`, `decode.go`, `rects.go`, `ops_tree.go`, `ops_space.go`,
  `identity.go` (the table in 2.7), `testdata/ops/*.json`, `testdata/rects.json`,
  `testdata/kinds.json`. Port of the toy's `norm`, `removeNode`, `detach`, `insertBeside`, `lca`,
  `besideInfo`, the plain branch of `lay`, `sideNeighbours`, `adjacent`.
- **Depends on**: nothing. Parallel with 5 and 8.
- **Verify**: table tests per op (each case a JSON file: state, op, expected state), a property test
  that every op leaves normal form, `go test -fuzz` targets for `Decode` and for random op
  sequences (no panic, normal form, a tab id in one place). No end-to-end step: nothing is wired.
- **Size** M. **Risk**: the JSON case format is a contract for PRs 2, 9 and 10; fix it here.
- **Version window**: not wired; none.

### PR 2 — `feat(layout): placement, smart swap, closing and restoring a thread`

- **Goal**: every rule of the spec's "Linked surfaces" section as pure functions.
- **Adds**: `place.go` (`Place`, `ThreadTarget`), `thread.go` (`OpenThread`, `CloseThread`,
  `Restore`, `MoveThreadToSpace`, `Archive`, `Snooze`, `Unsnooze`), `swap.go`. Reference: the toy's
  `place`, `pickPane`, `kindSize`, `threadTarget`, `stashLinked`, `putBack`, `unstash`,
  `smartSwap`, `moveThreadToSpace`, changed where the spec differs (open questions 1, 2, 5 must be
  answered first).
- **Depends on**: 1. Parallel with 3.
- **Verify**: the table in section 5.1. No end-to-end step.
- **Size** L. **Risk**: the spec and the toy differ; the worker must not copy the toy's family
  rules without the owner's answer.
- **Version window**: none.

### PR 3 — `feat(layout): the layout store, LayoutService and the layout event source`

- **Goal**: layout state in the daemon, published and changeable.
- **Adds**: `0061_layout.sql` + `internal/db/layout_migration_test.go`; `internal/store/layout`
  (`Manager`, `Snapshot`, `Apply`, write-through of focus, `layouttest`); `layout.proto`, the
  `events.proto` additions, `make gen`; `internal/api/layout.go`, `layout_events.go`; one line in
  `Events.sources()`; wiring in `internal/daemon/stores.go`; `internal/client` accessor. Ops PR 2
  owns answer `Unimplemented` until it merges (the handler looks ops up in a registry).
- **Depends on**: 1. Parallel with 2.
- **Verify**: store tests (persist and reload, rev, one event per commit, resync snapshot, a
  corrupt doc is repaired not fatal); API tests; end to end: scratch daemon,
  `code-foundry events --source layout` shows the snapshot, a `grpcurl`-free check through a small
  Go test client that applies `NewSpace` and sees the delta.
- **Size** L. **Risk**: the event shape is hard to change later; review it against 2.4.
- **Version window**: an older GUI drops the unknown event kind (verified in `api/events.ts`); add a
  vitest case that pins it. A newer GUI with an older daemon sees no layout source: flag off, no
  effect.

### PR 4 — `feat(command): space, pane, tab and thread.open commands`

- **Goal**: every layout action as a command; the CLI can read and arrange a layout.
- **Adds**: `commands_space.go`, `commands_pane.go`, `commands_tab.go`, `commands_layout.go`
  (`layout.show`), `commands_thread_open.go` (`thread.open`, `thread.close`, `thread.space.move`);
  id kinds; `Register` in `internal/command/all`; classification lists (`palette_test.go`,
  `index_test.go`, `readonly_test.go`, `page_class_test.go`); the guide topic `layout`
  (`internal/guide/topics.go`). No default chords.
- **Depends on**: 2, 3.
- **Verify**: command tests with `layouttest`; refusals from inside a thread without explicit ids;
  end to end on a scratch home: `thread new`, `thread open`, `tab move --split`, `pane resize`,
  `layout show`, `space new`, `thread space move`, restart the daemon, `layout show` again.
- **Size** L. **Risk**: the arg design is the model's interface; keep to 2.8.
- **Version window**: new verbs only; an older GUI's palette lists them from `CommandService.List`
  and they act on the daemon's layout, which that window does not show. Acceptable on `shell`.

### PR 5 — `feat(terminal): free shells, the quick slot, live directory and foreground command`

- **Goal**: what terminals need (2.10).
- **Adds/changes**: `internal/termlabel` (`Free`, `Slot`), `internal/store/terminal` (facts, a new
  file), `terminal.proto` fields, `internal/daemon/shells.go` (ownerless rule),
  `commands_terminal.go` (`terminal.new-free`, `terminal.reset`, `terminal.rerun`), mock
  `shells.ts`.
- **Depends on**: nothing. Parallel with 1-4.
- **Verify**: store tests with a real PTY (cd changes `live_cwd`; `sleep 5` shows as foreground and
  then as `last_command`); reaper tests (a free shell is not reaped by the project sweep);
  end to end: `terminal new-free`, `terminal list --json`.
- **Size** M. **Risk**: reading another process's cwd on macOS; cgo stays out (use what
  `internal/procscan` already uses or a syscall, never cgo outside its owning goroutine).
- **Version window**: new proto fields; an older GUI ignores them.

### PR 6 — `feat(layout): thread and terminal lifecycle reach the layout`

- **Goal**: creating, archiving, snoozing, removing and moving threads, and terminals exiting, keep
  the layout true.
- **Adds**: `internal/daemon/layout.go`: a created thread joins its creator's space, else the
  current one (a user's own new thread also gets `OpenThread` in place of its `compose` tab);
  archive closes linked tabs everywhere and drops the set; snooze closes them, records `fresh`
  terminal entries, keeps the set; unsnooze and send leave it closed; remove deletes the row; a
  removed terminal's tab closes; a free shell whose tab closed is ended; presence feeds the
  viewport. `terminal.new` gives a thread's new shell a linked tab; `terminal.quick`,
  `terminal.cycle` (`commands_terminal_quick.go`).
- **Depends on**: 4, 5.
- **Verify**: glue tests with fakes (the pattern of `plugin_hooks` tests); end to end: a thread with
  a diff tab and two shells; `thread snooze`; `layout show` (tabs gone, set kept); unsnooze;
  `thread open`; the set is back with fresh shells.
- **Size** M. **Risk**: ordering between `removeShells` and recording `fresh` (record first).
- **Version window**: the classic window is unaffected; its bottom panel still derives tabs from
  labels (the quick label is ignored there).

### PR 7 — `feat(command): view.open verbs place linked tabs; the panel item verbs alias them`

- **Goal**: 2.9.
- **Adds**: `commands_view_open.go`; the item verbs' `Run` applies the layout op and still emits the
  `ShowView`; `thread.focus`, `ui.focus.terminal`, `view.pullrequests`, `view.projects` do both
  too; mock `panelItemVerbs.ts`.
- **Depends on**: 6.
- **Verify**: command tests (the op, the alias, no focus from a thread, `--focus`); existing item
  verb tests stay green; end to end from a thread's environment (`CODE_FOUNDRY_THREAD` set).
- **Size** M. **Risk**: double effects in the classic window (must be none: it ignores layout).
- **Version window**: as designed, both forms work.

### PR 8 — `refactor(gui): surfaces reach their tab through a host seam`

- **Goal**: no surface code imports `stores/panel.ts`.
- **Adds**: `src/shell/host.ts` with the classic implementation; **edits** the importers outside
  `components/panel` and `components/bottom` (`stores/filePanel.ts`, `prPanel.ts`, `mcpPanel.ts`,
  `pluginPanel.ts`, `emberPanel.ts`, `fileEdit.ts`, `fileFind.ts`, `fileRequest.ts`,
  `recentFiles.ts`, `mcpTabs.ts`, `pluginTerminals.ts`, `components/files`, `diff`, `pr`, `plugin`,
  `ember`, `palette/FileFinder`, `surfaces/*`) to use it. No behaviour change.
- **Depends on**: nothing. Parallel with the daemon track. May be split by surface family (files and
  diff; pull request; mcp, gallery, plugin, ember) into three PRs that run in parallel after the
  seam file lands.
- **Verify**: the whole existing vitest and e2e panel suites, unchanged, are the test; a guard test
  that nothing outside `components/panel`, `components/bottom`, `stores/panel*`, `stores/views.ts`,
  `stores/threadPanelIntent.ts` and the seam imports `stores/panel`.
- **Size** L (mechanical). **Risk**: silent behaviour drift in 36 test files' worth of surface
  logic; keep signatures identical.
- **Version window**: GUI only; none.

### PR 9 — `feat(gui): shell geometry: rectangles with minimums, rails, tab fitting`

- **Goal**: the pure render-time functions.
- **Adds**: `src/shell/geometry/rects.ts` (the toy's `lay`/`minOf`: 12px gutters, pane minimums by
  active kind), `rails.ts` (fold order: panes without a thread tab first, least recently focused
  first, then panes with thread tabs; the focused pane and the pane of the focused thread never
  fold; 36px rails), `tabFit.ts` (active tab full, others shorten, then icon-only),
  `neighbours.ts` (direction keys on the rendered frame).
- **Depends on**: 1 (fixtures). Parallel with 2-8.
- **Verify**: vitest on `internal/layout/testdata/rects.json` (plain case equals Go's) and its own
  tables; no browser.
- **Size** M. **Risk**: none beyond the rails order (pinned in 5.1).

### PR 10 — `feat(gui): the layout slice, its API mapping and the mock daemon's layout`

- **Goal**: the GUI can hold and change the layout.
- **Adds**: `src/api/layout.ts`, `src/stores/layout.ts`, one entry in `stores/events.ts`,
  `mock/layout.ts` + seeds + the `layout`/`space`/`pane`/`tab` commands in the mock, the flag
  (`src/shell/flag.ts`), `SetViewport` reporting.
- **Depends on**: 3 (proto). Parallel with 2, 4-9.
- **Verify**: vitest (delta application keeps identity; optimistic focus is corrected; mock ops
  against `testdata/ops`); nothing visible yet.
- **Size** M.
- **Version window**: flag off; none.

### PR 11 — `feat(gui): the pane grid with tab strips and focus, behind the shell flag`

- **Goal**: with the flag on, the window is the pane grid of the current space.
- **Adds**: `components/shell/Shell.tsx`, `PaneGrid.tsx`, `PaneView.tsx`, `PaneTabStrip.tsx`,
  `Gutter.tsx` (drag commits `pane.resize`), `EmptySpace.tsx` (the home composer);
  `src/shell/surfaces/registry.ts` with `thread`, `file`, `diff`, `pullrequest`, `prs`, `projects`,
  `compose`, `mcp`, `gallery`, `plugin`, `ember.board`; the shell half of `host.ts`;
  `stores/selectionBridge.ts`; `stores/shellView.ts`; `src/shell/keys.ts` (the interim key table);
  `App.tsx` switches on the flag. The sidebar is still the classic one (a click routes through the
  bridge to `thread.open`).
- **Depends on**: 4, 8, 9, 10.
- **Verify**: vitest (strip rendering and close, which body mounts, the bridge's selection for each
  tab kind, the key table against the spec's table); e2e `shell-grid.spec.ts` (gutter resize keeps
  the tiling; focus moves between panes by click and by `ctrl+cmd+hjkl`; stream counts: two panes
  showing two threads hold two `WatchThread`s and a hidden tab none); end to end with
  `make drive DAEMON=dev` and `?shell=1`: open two threads, split with the CLI, resize, reload.
- **Size** L. **Risk**: the largest GUI PR; the single-selection assumptions surface here. If it
  grows, cut the surfaces other than `thread` and `diff` into a follow-up.
- **Version window**: flag on needs the daemon of PR 4; otherwise classic with a notice.

### PR 12 — `feat(gui): linked tabs: the row under the strip, the pane's plus menu, the thread header`

- **Goal**: linked surfaces behave as the spec says in the window.
- **Adds**: `components/shell/LinkedRow.tsx` ("Diff of ● thread", the link back, the name looked up
  from the thread id; dormant when the thread is not open in this space); `PanePlusMenu.tsx`
  (shadcn dropdown with a thread submenu: its surfaces with "open" marks, its terminals, "New
  terminal tab"; then New thread, Terminal, Pull Requests, Projects); the thread header
  (`components/thread/ThreadHeader.tsx`: branch chip, info toggle, one three-dot menu with Open,
  Move to space, rename, snooze, archive, close); `cmd+shift+d` there and back; the attention mark
  on a tab opened behind.
- **Depends on**: 7, 11. Parallel with 13, 14.
- **Verify**: vitest (menu contents with and without a thread tab; the row's text; which command
  each item runs); e2e only for the submenu's hover and keyboard path; end to end: `cmd+shift+d`
  twice, a model-side `view.open.diff` from a second thread lands without taking focus.
- **Size** M.

### PR 13 — `feat(gui): terminal tabs and the quick terminal`

- **Goal**: the spec's "Terminals" section.
- **Adds**: `src/shell/surfaces/terminal.ts`; `components/shell/QuickTerminal.tsx` inside the thread
  pane (pushes while the composer and `CHAT_MIN` of conversation fit, overlays otherwise; header
  with the directory and the right-aligned Reset hint); `lib/terminalName.ts`; the restored-shell
  line with "Run again"; `cmd+t`, `cmd+shift+t`, `cmd+j`, `cmd+shift+j` in the interim table;
  code blocks' Run in terminal routes to a linked tab.
- **Depends on**: 6, 11. Parallel with 12, 14.
- **Verify**: vitest (names and icons; the hint's condition; the `cmd+j` three states); e2e
  `shell-terminal.spec.ts` (xterm renders in a tab and in the quick slot; one `Attach` per visible
  terminal and none for a hidden tab; push versus overlay at two pane heights); end to end: the ring
  across two terminal tabs, Reset after `cd /tmp`.
- **Size** L.

### PR 14 — `feat(gui): drag tabs and panes`

- **Goal**: every drag in the spec except onto a space tab (PR 15).
- **Adds**: `src/shell/drag/targets.ts` (pure: pointer + frame → strip index, pane edge, outer edge),
  `components/shell/ShellDnd.tsx` (dnd-kit), drop previews, screen reader announcements. Any tab
  drags, active or not; a pane drags by its strip's empty area.
- **Depends on**: 11. Parallel with 12, 13.
- **Verify**: vitest on `targets.ts` (every zone and its precedence); e2e `shell-drag.spec.ts`
  (reorder, to another strip, to an edge, pane to an edge, pane onto a strip, outer edge; the grid
  tiles with no gap after each).
- **Size** L. **Risk**: WebKit pointer events over iframes and xterm (see
  `docs/notes/panel-split-3-drag.md` and `testing-gotchas.md`).

**Milestone M1** (after 12, 13, 14): on `shell` with `?shell=1` or the localStorage flag, one space
works: panes, tabs, linked surfaces, terminals, drags.

### PR 15 — `feat(gui): the top bar and spaces`

- **Goal**: spaces in the window.
- **Adds**: `components/shell/TopBar.tsx` (app name, sidebar toggle, `HistoryButtons`, space tabs
  with an icon drawn from the space's tree (`SpaceIcon.tsx`, from `Rects` at 16 x 12), the name, the
  count of its threads that need the user, "+"); `stores/focusHistory.ts`; `ctrl+cmd+1…9`; drops
  onto a space tab (tab, pane); Move to space in menus; the sidebar lists the current space's
  threads; the window drag band moves to the top bar.
- **Depends on**: M1.
- **Verify**: vitest (history push, skip of dead entries, the count); e2e (drop on a space tab;
  focus history across spaces); end to end: two spaces, move a thread with its linked tabs,
  `space remove`.
- **Size** L. **Milestone M2: spaces.**

### PR 16 — `feat(gui): sidebar sections and the thread row`

- **Goal**: the spec's "Sidebar" section except the inbox interactions.
- **Adds/changes**: `lib/tree.ts` sections (Needs you, Active, footers), `components/sidebar/*`
  (the three-line row; hover controls; no Pull Requests or Projects rows; Open ▸ in the row menu,
  which follows placement for an open thread and opens in the focused pane for a closed one), the
  All spaces / This space toggle (setting `sidebar.needs_scope`), `layout.smart_swap` on Settings.
- **Depends on**: 11 for the click target; otherwise parallel with 12-15.
- **Verify**: vitest (section membership, order, a Needs-you thread is not also under Active, the
  row's lines for a thread with no project); e2e only for row truncation and hover geometry.
- **Size** M.

### PR 17 — `feat(gui): the Needs-you inbox`

- **Goal**: the hover card, the popup, the top-bar popover, the marks and the in-pane strip.
- **Adds**: `components/needs/NeedsCard.tsx` (the whole ask; Allow, Deny, Go to thread for a
  permission; a question offers the popup and the thread; pointer can enter it; grows to a maximum,
  then scrolls), `NeedsPopup.tsx` (recent messages, the ask with `PendingPrompt` and its deny-reason
  field, Go to thread; a visible thread view, so it may hold the shared `WatchThread`),
  `NeedsPopover.tsx` (top bar control with the count when the sidebar is collapsed), the attention
  dot on tab icons in strips and rails, `AskStrip.tsx` above the composer when the pane is too
  short, `cmd+shift+a`.
- **Depends on**: 15, 16.
- **Verify**: vitest (which threads are listed: the user's own only; card contents per ask kind;
  the popup dismisses the hover card until the row is hovered again); e2e (entering the card with
  the pointer; the strip appearing at a short pane height).
- **Size** L. **Milestone M3: the inbox.**

### PR 18 — `feat(layout): import the old panel and terminal state` (daemon half)

- **Adds**: `internal/layout/legacy.go`, `LayoutService.ImportLegacy`, fixtures from
  `panel.migrate.test.ts`.
- **Depends on**: 6. Parallel with the GUI track.
- **Verify**: the table in section 3; end to end with a Go test client on a scratch home.
- **Size** M.

### PR 19 — `feat(gui): rails and full screen with the floating composer`

- **Adds**: rails in `PaneGrid` (icons of the pane's tabs, the selected one marked, attention dots;
  click unfolds by focusing), `pane.fullscreen` (top bar and sidebar stay; pane focus and move keys
  do nothing), `components/shell/FloatingComposer.tsx` (a pill, expanded on demand, the thread's
  chip centred above it as the drag handle, always opening at the same spot, a drag lasting until
  full screen ends, the draft kept per thread through the existing draft store).
- **Depends on**: M1 (9 and 11). Parallel with 15-18.
- **Verify**: vitest (rails order through `rails.ts`; full screen state rules); e2e
  `shell-rails.spec.ts` (shrink the window: the right panes fold in order and unfold; the stored
  layout is unchanged; a folded pane holds no stream), `shell-fullscreen.spec.ts` (the composer's
  drag and its reset).
- **Size** L. **Milestone M4: rails and full screen.**

### PR 20 — `feat(gui): the shell is the default window; first-load import`

- **Goal**: cutover.
- **Changes**: the flag defaults on (`?shell=0` and the localStorage flag still give classic for
  one PR); the GUI calls `ImportLegacy` before first draw; chords move into `Command.Keybindings`
  and `ReservedChords` is updated (`cmd+w` and `cmd+alt+\` leave it; `ctrl+cmd+1…9` join);
  `src/shell/keys.ts` is deleted; `SHELL_SINCE` in `lib/update.ts`; keybinding tests rewritten
  (`TestPanelKeybindings` goes, a test pins the spec's table).
- **Depends on**: 12-19.
- **Verify**: vitest (the import call happens once; the gate); the full e2e suite on the shell with
  the specs that cannot pass skipped by name with a pointer to PR 21 (listed in the PR body);
  end to end on a **copy** of a real home: old panels and terminals come back as the spec says.
- **Size** M. **Risk**: this is the on-disk migration; the lead asks the owner before merging it
  (the repo's rule for migrations).
- **Version window**: new GUI with a daemon before PR 18: the update dialog. Old GUI with this
  daemon: classic, unchanged.

### PR 21 — `refactor(gui)!: remove the side panel, the bottom panel and their stores`

- **Removes**: `components/panel/*`, `components/bottom/*`, `stores/panel.ts` and its tests,
  `stores/bottomPanel.ts`, `stores/bottomActions.ts`, `stores/threadPanelIntent.ts`, the panel and
  bottom functions of `stores/views.ts`, selection history and panel constants in `stores/ui.ts`,
  the classic branch of `App.tsx`, the classic half of `host.ts` and the flag, the Pull Requests and
  Projects sidebar rows' code, e2e `panel*.spec.ts`, `bottom-panel.spec.ts`,
  `terminal-routing.spec.ts`, `layout.spec.ts`, and the vitest files of the removed modules.
  Rewrites the remaining specs that used panel test ids against the shell (5.3).
- **Depends on**: 20.
- **Verify**: `make check`, `make gui-e2e` fully green with no skips; the design guards.
- **Size** L (mostly deletions). May be split: stores and components; tests.

### PR 22 — `refactor(command)!: retire the panel verbs and the legacy view intents`

- **Removes**: `view.panel.toggle`, `.expand`, `.new-tab`, `.split`, `view.bottom.toggle` and their
  `ShowView` names; the `ShowView` emission of the item verbs; `ShowView.thread_id` handling in the
  GUI; `appearance.panel_keep_open`; the mock's `panelVerbs.ts`. Keeps the `view.panel.<item>`
  aliases (open question 7).
- **Depends on**: 21.
- **Verify**: command and guide tests; a stale `[keybindings]` override naming a removed command is
  reported, not fatal (test).
- **Size** M.
- **Version window**: an old GUI with this daemon no longer shows a model's item verbs (stated in
  2.12).

### PR 23 — `docs: the shell in the architecture, the guide and the skills`

- **Changes**: `docs/ARCHITECTURE.md` (§3 packages, §4 `LayoutService`, `UiService`, the event
  sources, §5 labels, §7 commands, §8 layout, streams and keys), `docs/GETTING-STARTED.md`,
  `internal/skills/files/**` (the files in 1.1), `internal/guide`, their tests, and one summary
  note `docs/notes/shell-build.md` linking the per-PR notes.
- **Depends on**: 22. **Size** M.

### PR 24 — `test(shell): fuzz, rehearse the migration and close the gaps`

- **Does**: Go fuzz corpus run for op sequences; an e2e fuzz of random drags asserting the tiling
  (the pattern of `plugins-layout-fuzz.spec.ts`); stream-count checks across a space switch and a
  full screen; the migration rehearsed on copies of real homes (owner's and one more user's, with
  their consent) and its report in the note; plugin surfaces and plugin terminals in tabs; Ember's
  chat and board; dictation into a pane's composer; the update dialog path with a real old daemon;
  zoom at 90% and 200%; a11y of strips and drags; `make gui-build` and a manual pass over the
  spec, section by section, with every difference listed.
- **Depends on**: 23. **Size** M-L, likely several small fix PRs.

### PR 25 — `feat(gui)!: the shell: spaces, panes and linked surfaces` (`shell` → `main`)

- One merge commit. Before it: rebase `shell` onto `main`, `make check`, `make attest`. The body has
  the before and after screenshots and the list of differences from the spec. The owner is asked
  before the merge (an on-disk migration). The sweep on `main` then publishes the tip.

---

## 5. Test plan

### 5.1 What unit tests pin

Go (`internal/layout`, table tests, one JSON case per row where a GUI test shares it):

- **Placement**, one case per rule and per tie-break: rule 1 focuses and opens no second copy;
  rule 2 joins the pane holding this thread's linked tabs, after the last of them; rule 3 with
  candidates on several sides picks in the order right, left, below, above, and before that a pane
  already holding a linked tab of this thread, and after that the nearest (centre distance); rule 4
  the same over the whole space; rule 5 only when the conversation keeps 480px, at the kind's
  default size, as a split of the thread's pane and not of its column; a joined pane is never
  resized (sizes equal before and after); rule 6 otherwise, right after the thread's tab; the thread
  not open: the focused pane; a `--pane` choice from "+" wins except for an already-open linked tab.
- **Identity**: each kind's key; a workspace thread gets one diff per repository; `terminal` never
  matches; `prs` and `projects` one per space.
- **Smart swap**: only panes whose active tab is another thread's surface of the same kind, and only
  when this thread's is already in that pane; nothing opens, moves or closes; the setting off; the
  last-active choice among several.
- **Close and restore**: the remembered record (pane, index, active, adjacent, beside); restore into
  the old panes when the thread is back in its old pane; placed fresh otherwise; a pane that was
  removed is rebuilt beside its old neighbours at its old share; terminals survive a close and come
  back fresh after a snooze; archive forgets.
- **Move to space**: takes the linked tabs that are in its space, leaves a dormant one that was
  dragged elsewhere.
- **Focus**: `mru` order; `CloseTab` returns focus to the previous entry in the space; closing the
  last tab of a pane.
- **Normal form** after any op sequence (property and fuzz).
- **Legacy import** (section 3).
- Store: rev, events, reload, repair. Commands: args, refusals, focus rules, aliases.
  `keybindings_test.go`: the spec's key table, exactly, and the retired chords absent.

vitest:

- `geometry/rects` (shared fixtures), `rails` (order: no-thread panes first by least recent focus,
  then thread panes; the focused pane and the focused thread's pane never fold; unfolding when
  there is room), `tabFit`, `neighbours`, `drag/targets`.
- `stores/layout` (delta application, identity preserved, optimistic focus), `focusHistory` (push
  rule, dead entries skipped, across spaces), `selectionBridge`.
- The key table until PR 20; menus' contents; the linked row; terminal names; sidebar sections; the
  inbox list and cards; which command each control runs with which args.
- The two kind registries agree.

### 5.2 What needs a browser (e2e, WebKit, the mock with seeded trees)

Gutter resize and tiling; every drag; focus moving between panes and regions and through the
keymap's global chords; xterm in a tab and in the quick slot; the quick terminal's push and overlay;
rails folding on window resize; full screen and the floating composer's drag; stream counts
(`WatchThread`, `Attach`) per visible view and zero for hidden tabs, folded panes and other spaces;
the hover card's pointer path; computed theme CSS for the new chrome; one flow across the daemon's
streams (open a thread, a model opens a diff, close the thread, reopen).

Opt-in live specs (`e2e/live-shell.spec.ts`, real daemon on a scratch home): the placement rules
end to end once, and the migration.

### 5.3 The existing panel tests

- `stores/panel.test.ts`, `panel.groups.test.ts`, `panel.migrate.test.ts`, `bottomPanel.test.ts`,
  `bottomActions.test.ts`, `views.split.test.ts`, `ui.history.test.ts`, `components/panel/*.test.*`:
  deleted in PR 21. `panel.migrate.test.ts`'s cases are first captured as fixtures for the Go port
  (PR 18).
- Surface tests (`surfaces/*.test.*`, `filePanel.test.ts`, `prPanel.test.ts`, `mcpTabs.test.ts`,
  `fileEdit.test.ts`, …): kept; PR 8 moves them onto the seam, PR 21 onto the shell host with a
  small fake.
- e2e: `panel.spec.ts`, `panel-split.spec.ts`, `panel-split-drag.spec.ts`, `bottom-panel.spec.ts`,
  `terminal-routing.spec.ts`, `layout.spec.ts` are replaced by the `shell-*.spec.ts` files; their
  assertions that were logic (which tab opens, which command runs) are not re-created in e2e, they
  are covered by Go and vitest. The other ~27 specs that open a panel to reach a surface
  (`file-tabs`, `diff-viewer`, `pr-panel`, `mcp-panel`, `gallery`, `page-verbs-panel`,
  `thread-panel-items`, `thread-info`, `waiting-strip`, `sidebar`, …) keep their surface assertions
  and change only how they open the tab (a shared fixture helper `openTab(page, …)` added in PR 11).

---

## 6. Open questions for the owner

Ranked by how much they block. Each has my recommendation; none is resolved in this plan.

1. **Do terminals follow the same six placement rules as every linked surface?** (blocks PR 2) The
   spec has one rule set and "a new pane to the right". The toy places by family: a terminal joins
   only panes holding terminals, and a new terminal pane goes *below* the thread at 180px or more.
   Sketch 01 shows a terminal pane under a diff pane. Recommendation: follow the spec's text (one
   rule set, right), and if the toy's behaviour is what was agreed, change the spec first.
2. **Which pane does a thread's tab open in** on a sidebar click, on `thread.open` from the CLI, and
   for a new thread? (blocks PR 2) The spec is silent. Recommendation: the toy's rule: the focused
   pane if its active tab is a thread; else the pane of the focused linked tab's thread; else the
   most recently focused pane showing a thread; else any pane with a thread tab; else a new pane
   left of views or above terminals.
3. **What is "the thread last viewed" at first load?** (blocks PR 18 and 20) Nothing stores it: the
   selection is not persisted and the daemon has no viewed time. Recommendation: ship a small PR to
   `main` now that persists the last selected thread id in `code-foundry.ui`, so users have it by
   the time the shell lands; fall back to the sidebar thread with the newest user message, and to an
   empty space when there is none.
4. **Pins and finished turns in the new sidebar.** (blocks PR 16) The spec lists Needs you, Active,
   Working, Snoozed, Archived. Recommendation: Active keeps today's order (pinned first, then
   finished turns, then idle) and Pin stays in the row menu.
5. **May rules 3 and 4 join a pane that holds a thread tab?** (blocks PR 2) The toy never does (such
   a pane is a conversation pane; rule 6 covers the thread's own). The spec says only "holds linked
   surfaces". Recommendation: the toy's exclusion.
6. **Closing a terminal tab by itself (`cmd+w`).** (blocks PR 13) Sketch 04c lists a thread's
   terminals with and without "open", so a linked terminal can run without a tab. Recommendation: a
   linked terminal's tab closes and the shell keeps running, reachable from "+" and the info card,
   where it can be ended; a free terminal ends with its tab, asking first when something runs in it.
7. **Verb names.** (blocks PR 7, 22) Recommendation: `view.open.*` as the names, the
   `view.panel.<item>` verbs kept as unlisted aliases for one stable release, then removed with `!`.
8. **Removing a space.** (blocks PR 15) Not in the spec. Recommendation: confirmed; its threads move
   closed (sets kept) to the space on its left; unlinked tabs close and free terminals end; the last
   space cannot be removed.
9. **"The last command" for Run again.** (blocks PR 5) Recommendation: the foreground job's command
   line as the process list shows it, with no shell integration; a pipeline shows its first process.
   Exact text would need hooks injected into the user's shell.
10. **Surfaces opened where no thread is in play** (a checkout's diff or a file from the Projects
    surface, a pull request from the Pull Requests surface). (blocks PR 12) Recommendation: an
    unlinked tab in the same pane as the page, next to it, as "+" does; a pull request that a thread
    of this space links opens linked to that thread instead.
11. **The composer and an empty space.** (blocks PR 11) Recommendation: New thread opens a `compose`
    tab that becomes the thread's tab on send; a space with no pane draws the home composer.
