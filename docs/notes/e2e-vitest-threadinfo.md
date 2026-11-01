# e2e → vitest: thread info, project sets, lineage, plugins, the bridge

The thread info card and header, the card's and the composer's project sets, lineage, plugin
surfaces and flags, and the page bridge: 56 audited e2e tests (about 170 s). Each was read
against the unit test the audit named; where none made the same assertion, one was written.

## What moved

New component tests:

* `components/threadinfo/ThreadInfoCard.test.tsx` (13): the whole card over the mock's
  thread-info scenarios. The place group (Fresh copy, the project menu, Open in, the last run
  action), the git group (branch and ahead, linked PRs and their lines, changes, the Changes and
  PR tabs it opens, Branch copied), shells, lineage (live rows, stop squares by click and Enter
  without opening, Previous agents, a child's row opening it), MCP, context and usage (the
  warm cache, the hover cards, the fold's kinds, total, savings, requests), the action menu (a
  gear per action opens its editor and runs nothing, the text runs it), nine projects in a
  workspace (Run in items, the other project's action, PRs over four projects, the Changes
  fold, Fix sending once on a double click), Push waiting for the model, a child's parent row,
  no git, server rows (+N, open, stop once), an expired cache, under a cent, the MCP row's
  counts, colours, menu, Reconnect and openers.
* `components/threadinfo/ProjectSet.test.tsx` (4): Add project (one pick, "+N", "Every project
  is in this thread."), leaving the workspace (the header crumb), Save as workspace, Use
  workspace, Run in's × (tooltip, no Run in, the daemon's confirm), a moved member greyed.
* `components/compose/ComposerSets.test.tsx` (13): Add project's multi-select (open across
  picks), chips, Clear, the primary picker and thread.new's args; Work in's existing branches
  and Branch from (lists, filters, footer, base_from_origin off); a workspace row and its chip's
  ×; the collision banner and the daemon's hints not toasted again; a removed workspace; a
  refused branch in Work in; Save as workspace from the title menu (args, the item going, a
  taken name refused in place); New thread on this branch from the row and title menus (the
  read-only set, mode, banner, primary, thread.new-like).
* `components/plugin/PluginSurface.test.tsx` (9): a surface tab over the hello demo's captured
  views with a faked WatchSurface: header, tabs and tab title, acts with the panel's thread,
  command buttons and the daemon's confirm, a tab's choice, log tones and appended lines, the
  form (host checks, drafts across tabs, the multi-select, the values sent, a stored secret's
  placeholder), the layout tab's toolbar and footer (search on Enter, a chip, Clear, a reset
  token, no strips elsewhere), the plugin going down and its restart, the side panel's surface
  list, and the ShowView and InvokeCommand intents ("Asked by Hello").
* `components/files/PageErrors.test.tsx` (3): the strip's count, the popover's rows (latest
  first, "2×"), Ask Claude filling the composer without sending.

Additions: the sidebar card's "Created by … (removed)" line and a flag arriving live
(`SidebarRow.test.tsx`), attentionIds with child threads and orphans (`threads.test.ts`), the
crumb's order and the removed creator's "Thread removed" tooltip (`ThreadParts.test.tsx`), the
lineage menu (`LineageGroup.test.tsx`), the empty panel's + entries (`SidePanel.test.tsx`), and
md-thrash, a deterministic select-and-Back thrash (`layoutprobe.test.tsx`).

Fakes:

* `src/test/threadInfoWorld.ts`: the mock's thread-info scenarios (single, busy, child, nogit,
  servers, ws9) as view models over projectsWorld, with helpers for logs and thread updates.
* `src/test/cardFakes.ts`: the card's reads besides commands (pull request details, action
  picks, editor apps, placement checks, refusals by project or project@branch).
* `src/test/pluginSurfaceFakes.ts`: WatchSurface as a stream the test pushes into, Act recorded.

Product code: none changed, nothing exported.

## e2e removed (38), shortened (16), kept (2)

Removed, 108 s of the rows' measured time: thread-info (6: busy, child, no git, servers,
expired cache, under a cent), project-sets (9: Work in, Branch from twice, the workspace row,
the workspace chip, the collision banner, a taken name, New thread from the row menu, a removed
workspace), thread-project-set (all 5; the file went), lineage (4: sidebar, header, removed
creator, attention count), plugins (7: demo, buttons, tabs and log, the form, the surface
list, down, InvokeCommand), plugin-flags (1), thread-header (3: child crumb, the panel's +, the
Changes row), plugin-env-restart (idle restart), page-verbs (project.add stays), plugins-layout-fuzz
(select and Back thrash).

Shortened to their browser part:

* thread-info "one project": the toggle and its reload, the usage card's lines (geometry), an
  open fold's computed background, the card stepping aside for the panel. One app load and a
  reload instead of three loads.
* thread-info action menu (gear geometry, hover blocks, arrows between item and gear), nine
  projects (the menu's width), the MCP row (value edge, menu under the row).
* project-sets: Work in and Run in on one row plus the prompt's focus after picks; Save as
  workspace's name taking focus as the menu closes; Escape back to the thread (the keymap) and
  the palette's entry.
* lineage: ArrowDown from the creator's highlighted row. thread-header: a menu pick giving the
  prompt the keyboard. page-verbs: composer.stage in the real editor. page-library: the dash
  through ui.css in the frame.
* bridge: errors from the frame, Ask Claude's text in the real prompt, a frame reload clearing
  them (SHOTS kept); cf.fetch's timeout aborting the daemon's request (its SHOTS screenshots now
  run only under SHOTS).
* plugins: Settings → Plugins opening a surface across routes; the layout strips' geometry and
  CSS; the runs tab's focus, pane height and wide geometry.

The 16 shortened tests took 57 s in the audit's rows and 26 s in the final run. The rows were
measured on the dev server before #467 and the final run is on the bundled build, so part of
that drop is #467's.

The final run of every touched spec (2 workers): 89 passed, 4 skipped (SHOTS), 91 s.

Kept:

* bridge "the lightbox's copy of a page has its thread's bridge": the lightbox frame's own
  bridge answering is the real iframe's; HtmlFrame.test.tsx already has the nonce per frame.
* plugin-gaps "a row showing a plugin's flag opens … the plugin's surface": the click wiring
  lives in Sidebar's virtualized list, which jsdom lays out empty, and the surface going live is
  the plugin host's stream. Its status and reason asserts were dropped (SidebarRow.test.tsx).

## Rules that belong in Go, not here

Not moved, already Go's: a thread leaving its workspace on a set change and the dirty-checkout
question (`internal/command/commands_thread_project_test.go`, `internal/store/thread/members_test.go`),
placement refusals (`internal/store/thread/placement_check_test.go`), the case-insensitive
taken workspace name (`internal/store/workspace`), an idle restart not asking
(`commands_thread_restart_test.go`), cf.fetch's loopback refusal
(`internal/proxyfetch/proxyfetch_test.go`). The mock's own answers (branch names like
cf/ship-the-shop-banner, "Stopped background shell", "Restarted Claude", the hello plugin's next
views, "2 of 6 runs") were not moved; the GUI side of each is.

## Gotchas

* A `vi.mock` factory that imports a module importing stores deadlocks the file (the stores
  import the mocked API while its factory waits): vitest hangs before the first test, no
  output. Keep fakes store-free (`cardFakes.ts`, `pluginSurfaceFakes.ts`), as `daemonFakes.ts`
  says.
* The composer focuses its prompt a frame after it mounts. A picker opened before that frame
  closes on the focus moving out of it; wait ~20 ms after mounting (`settle`).
* A command run refreshes the commands list (`refreshCommands` → the fake's `daemon.commands`);
  set `daemon.commands` to what the store holds, or command buttons and plugin surfaces whose
  show command is gone vanish mid-test.
* A row with no action (Context, a disabled Push) takes no focus, so `tooltipText` cannot open
  its Tip; a pointer move and 550 ms does.
* Save as workspace's name taking focus as the title menu closes, the like composer's Escape
  (the global keymap) and Add project's list staying open across picks all depend on real
  focus; the first two stayed in e2e, the third works in jsdom once the mount's frame is waited.
* The hint toasts after a create compare the daemon's warnings with the composer's own hint
  lines; the test uses a line the composer shows (lib/collisionHints hintLine's words).
* md-thrash replaces a real-time sampler (120 ms acts, 100 ms views, 30 samples) with settled
  acts and pushed views in a fixed order. The e2e version also asserted no console errors; the
  unit version does not.
