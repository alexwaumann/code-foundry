# No sidebar override, PR 2 of 2: daemon, commands, API, migration, skills (2026-11-01)

PR 1 (the GUI) stops reading `Thread.in_sidebar`, the setting and `thread.sidebar`; this
PR removes them from the daemon, the CLI, the proto and the database.

## Decision (Alex, 2026-11-01; not up for debate)

Both "hidden child thread" controls go: the setting `threads.show_created_threads` and
the per-thread override (`Thread.in_sidebar`, `thread.sidebar --shown`, `thread.new
--sidebar`). The one rule:

**A thread is in the sidebar iff it has no creator (`created_by` empty) or its creator
no longer exists (no thread with that id in the store; an archived creator still
exists).**

To take over a child's work the user forks it; the child stays its creator's. Children
stay reachable through the creator's thread info card, the palette and links. T3 Code
has no such control either.

## What was removed

* **Store** (`internal/store/thread`): `Thread.SidebarOverride`, `CreateOptions.InSidebar`,
  `Store.SetSidebar`, `checkSidebarOverride`, `SetShowCreatedThreads` and the manager's
  `showCreated`, `ListOptions.ShowCreated`, `threadtest`'s `SetSidebar`/`ShowCreated`, and
  `orphans.go` (the persisted adoption: a removed creator's children got the override
  `true`, at removal and at load). The rule derives that now, so nothing is stored.
* **Daemon**: `applyShowCreatedThreads`; Ember's `Config.ShowCreatedThreads`.
* **API / proto**: `Thread.in_sidebar` (62) and `CreateThreadRequest.in_sidebar` (21)
  are `reserved` (number and name); `rpc SetSidebar` and its two messages are gone. The
  rule is spelled out on `Thread.created_by`.
* **Commands**: `thread.sidebar` (and `commandtest`'s fake), `thread.new --sidebar` and
  its "shown in / hidden from the sidebar" message, `thread.list`'s `[in sidebar]` /
  `[hidden]` marks. `hiddenWorking` and the archive/remove confirm tests moved to
  `commands_thread_cascade.go` / `_test.go` (renamed from `commands_thread_sidebar*`).

## What the rule is now

`sidebar.go`: `Thread.InSidebar(exists func(id string) bool)` and `Known(threads)` (the id
set of a snapshot). Callers: `promptListed` (prompt history's project and all scopes)
and Ember's `projectSeeds` (PROJECTS.md lists only threads the user sees).

`ArchiveCascade(threads, root)` no longer takes a setting: every thread its walk reaches
has the thread above it as its creator, so it is hidden, and the cascade is the whole
live subtree (through archived ones, as before). A root that is not among the threads
has none: its children are shown. Remove uses the same walk; a child whose removal fails
is shown once its creator is gone, and the GUI learns it from the list republished by
the creator's removal (it derives the rule from the list).

## Migration 0053

`ALTER TABLE threads DROP COLUMN in_sidebar;` modernc.org/sqlite 1.60.1 bundles SQLite
3.5x (DROP COLUMN since 3.35), and 0016 already used it; no index or view names the
column. `db.go` no longer writes or reads it (`nullBool` went with it).
`thread_drop_in_sidebar_migration_test.go` migrates a DB at 52 with rows whose override
was NULL, 1 and 0 and checks the column is gone and the rows kept. The old 0040 test was
deleted (0040 itself stays: migrations are history).

## The setting on disk

Real users have `threads.show_created_threads` in `settings.toml`. The settings store
already had a pattern for a removed key: `retiredKeys` in `internal/store/settings/file.go`
(added when `projects.worktree_dir` went). `decode` deletes retired keys before
resolving, so the file loads with no "unknown setting" issue, and the next save (any
change in the app or `settings set`) rewrites the file without it (not even under
"# Ignored:"). `threads.show_created_threads` is now in that list;
`TestDecodeRetiredKeys` has a case for it. `settings get threads.show_created_threads`
exits 2 with "unknown setting".

## Skills and guide

* `code-foundry-orchestrate/reference/sidebar.md` rewritten: hidden while you exist (only
  a removal shows them), you answer their needs, no handing over (tell the user it is in
  your thread info card and that `thread fork --id <child>` gives them a thread of their
  own), archiving and removing take every thread below along. `wakes.md` lost "A child
  you handed over"; SKILL.md's intro, Archive step and pointer line follow.
* The guide's Conventions say a created thread is hidden and archived with you, nothing
  shows it, and to tell the user to fork it.
* `code-foundry-pages`: `thread.new` from a page makes this thread's hidden children;
  for threads the user will want in their sidebar a page passes `"created-by": ""` and a
  `project` id (an existing opt-out: the thread is then the user's own, not a child).
  The verbs table, the spawner example and the welcome page's demo instructions lost
  `sidebar`; `sources.md` lost `inSidebar` from thread-list.
* Archive and remove confirmations now end "To keep its work, fork it first
  (code-foundry thread fork --id <id>)." instead of asking the creator to hand it over.

## Gotchas

* A child the user had shown with the override (or `--sidebar`) is hidden again after
  the upgrade, and archiving its creator now archives it too. That is the decision; the
  verification run showed it (`shownkid` archived with `parent`).
* A child adopted by the old `orphans.go` (creator removed) keeps showing: its creator is
  still gone, so the rule agrees with the dropped override.
* The page bridge passes `created-by: ""` through (`lib/bridge.ts` keeps an explicit
  empty value), and the daemon then needs a project for placement, so the pages skill
  says to pass both.
* `bridgeSourcesDoc.test.ts` checks every backticked name in `sources.md` against the
  thread view; it is one way (doc to view), so dropping `inSidebar` from the doc is safe
  whichever PR lands first, but a doc that still names it fails once the view drops it.

## Verification

`make check` green after rebasing onto main with PR 1 (#460) in it (before that the
frontend still read the removed fields, so only `make go-check` passed). End to end with
`CODE_FOUNDRY_HOME=/tmp/nso2`, `advanced.claude_path` set to `cmd/fakeclaude`: main's
binary with `show_created_threads = true` in the file made a parent with a `--sidebar`
child, a `--sidebar=false` child and a plain one, and a child whose creator it removed
(adopted, override 1). This branch's daemon then migrated to 53 (column gone), listed
every thread without marks and with no `inSidebar` in `--json`, refused `thread new
--sidebar` (unknown flag), `thread sidebar` (unknown command) and `settings get
threads.show_created_threads` (unknown setting), loaded the stale key silently and
dropped it on the next `settings set`. `thread prompts --scope all` listed the orphan's
prompt and not the plain child's (creator exists). Archiving the parent archived all
three children and a grandchild (`cascaded=4`); removing a thread removed its child,
with the new fork wording in the confirmation.
