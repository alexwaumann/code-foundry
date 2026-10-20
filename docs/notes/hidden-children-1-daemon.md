# Hidden child threads, PR 1 of 2: daemon, commands, API mapping (2026-10-20)

Threads another thread created (`Thread.created_by` set) are managed by their creator,
not the user, so by default they stay out of the sidebar. A thread shown in the sidebar
is human-managed; a hidden one is thread-managed. This PR is the daemon side: the
setting, a per-thread override, the rule, the archive cascade and its confirmation, the
commands, the frontend view model, and the orchestrate skill's reference. PR 2 (the
GUI: sidebar, Dock badge, row menu, mock daemon) follows.

## Decisions (with Alex, 2026-10-20; not up for debate)

1. **Setting** `threads.show_created_threads` (bool, default false), General › Threads,
   "Show threads created by other threads": "Off: threads an agent creates stay out of
   the sidebar and the Dock badge, and are archived with their creator. They stay in the
   creator's Threads tab." `settings.KeyShowCreatedThreads`, `Threads.ShowCreatedThreads`.
2. **Per-thread override** `in_sidebar`, nullable (unset follows the setting), only on a
   thread with a creator (InvalidArgument on the user's own). Persisted.
3. **One rule** (`thread.Thread.InSidebar(showCreated)`; the GUI reimplements it, the
   proto comment on `Thread.in_sidebar` spells it out): no creator → shown; override
   set → the override; else the setting.
4. **Commands**: `thread.sidebar --shown=true|false` (id from the context like the
   others); `thread.new --sidebar` (only with a creator, which `--created-by` defaults to
   `$CODE_FOUNDRY_THREAD`).
5. **Archive cascades through hidden descendants only**, stops at a shown thread (it and
   everything under it stay), root last, failures logged and named, unarchive does not
   cascade. `thread.archive` also confirms when a hidden descendant it takes along is
   working.
6. **Dock badge / attention counts**: hidden threads do not count.
7. **Wake messages**: unchanged.
8. **Frontend mapping only**; no GUI change here.

Decided while building (flagged for review):

* **`ThreadFilter.archive_cascade_of`** (new filter field 13): the threads archiving a
  thread takes with it, in tree order with `depth` (and `totals`). The command's
  confirmation needs the effective rule, which needs the setting; rather than give
  `thread.archive` a settings backend and a third copy of the rule, it asks the daemon,
  whose store applies its own live setting. Exclusive with `descendants_of`
  (InvalidArgument). Archived ones are left out unless `include_archived`/`all`.
* **`thread.new --sidebar=false`** is accepted too (hide it even when the setting shows
  created threads). Without the flag `in_sidebar` stays unset.
* **`thread.list` marks an override**: `[in sidebar]` or `[hidden]` after the age, like
  `[archived]`. An unset override is not marked (the setting decides; the CLI does not
  read settings). `--json` carries `inSidebar` (absent when unset).
* **The cascade's walk** is `Subtree` (the `--descendants-of` walk: tree order, 8 levels,
  cycle safe) filtered to entries whose every ancestor below the root is hidden. It
  passes through hidden archived threads (a hidden child archived earlier keeps its
  hidden children reachable) and archives only the unarchived ones. Removed threads'
  tombstones are not walked (their visibility is unknown).
* **Order**: hidden descendants in tree order (a hidden lead before its workers, so it
  stops before they do and spawns no more), then the root, then one more pass for any
  hidden thread created below it while the others were being archived (its creator was
  still running), so none is left orphaned and invisible.
* **Partial failure**: the root is still archived, and `Archive` returns the thread with
  a `*thread.CascadeError` ("archived thread s-x, but 1 hidden thread below it was not
  archived: s-y: ..."), an `ErrFailedPrecondition`, so the API answers
  FAILED_PRECONDITION with that text and the CLI exits non-zero. An unknown root is
  NotFound before anything is archived.
* **No republish on a setting change**: the thread proto carries the override only, so a
  setting change changes no thread; the GUI reads the setting from its settings stream.
* **Owned (plugin) threads** have no creator (Owner and CreatedBy are exclusive), so the
  rule says "shown"; they are hidden from the user's lists by `owner` already.

## What was built

* **Proto** (`thread_lifecycle.proto`, `thread.proto`): `Thread.in_sidebar` (62,
  `optional bool`, with the rule), `CreateThreadRequest.in_sidebar` (21, optional),
  `ThreadFilter.archive_cascade_of` (13), `SetThreadSidebarRequest{id, shown}` /
  `SetThreadSidebarResponse{thread}`, `rpc SetSidebar`; the `Archive` rpc comment says it
  cascades. `make gen`, generated Go and TS committed.
* **Settings** (`internal/store/settings`): the field before "Name threads
  automatically" (the naming model must stay right after that one).
* **Migration `0040_thread_in_sidebar.sql`**: `ALTER TABLE threads ADD COLUMN in_sidebar
  INTEGER` (nullable: NULL follows the setting, 0 hidden, 1 shown; every existing row
  NULL). `db.go` saves `nullBool(SidebarOverride)` and scans a `sql.NullBool`.
  `internal/db/thread_in_sidebar_migration_test.go`.
* **Store** (`internal/store/thread`):
  * `sidebar.go` (new): `Thread.InSidebar`, `checkSidebarOverride`,
    `Manager.SetShowCreatedThreads` (guarded by `m.mu`), `Manager.SetSidebar`,
    `ArchiveCascade` (pure).
  * `thread.go`: `Thread.SidebarOverride *bool` (copy on write: replaced, never written
    through), `CreateOptions.InSidebar`, `Store.SetSidebar`, the cascade on
    `Store.Archive`'s doc.
  * `archive.go`: `Archive(true)` = cascade, `archiveOne` (the old body: close, remove
    shells, unpin, unsnooze, stamp, drop flags), root, straggler pass;
    `cascadeTargets`, `CascadeError`/`CascadeFailure`. Log lines: each cascaded thread
    "archived thread with the thread above it" (thread, root, depth); the root
    "archived thread" with `cascaded` and `cascade_failed`.
  * `filter.go`: `ListOptions.ArchiveCascadeOf`, `ShowCreated` (List fills it from the
    store).
  * `manager.go`: `Create` validates `InSidebar` (with a creator only) and sets it.
  * `threadtest`: `Fake.SetSidebar`, `Create`'s ` sidebar=<bool>`, `Fake.ShowCreated`
    for `List`'s cascade filter. The fake's `Archive` does not cascade.
* **Daemon** (`internal/daemon/settings.go`, `stores.go`): `applyShowCreatedThreads`,
  like `applyCacheTTL` (now and on every change through `settings.Store.OnChange`).
* **API** (`internal/api`): `thread_sidebar.go` (`SetSidebar`, `optionalBool`);
  `threadToProto` and `Create` map the field; `listOptionsFromProto` maps the filter;
  a List with it gets depths and totals like `descendants_of`.
* **Commands** (`internal/command`): `commands_thread_sidebar.go` (new): `thread.sidebar`,
  `SidebarBackend` (embedded in `ThreadBackend`), `thread.new`'s `sidebar` arg,
  `hiddenWorking`, `hiddenWorkingText`. `commands_thread_archive.go`:
  `archiveOneConfirm` (the thread's own clause plus the children's).
  `commands_thread_bulk.go`: `--ids` adds the children's clause.
  `commands_thread_list.go`: the marks. `commandtest`: `Thread.SetSidebar`,
  `Thread.Cascade` (List's answer to `archive_cascade_of`), Create echoes `in_sidebar`.
* **Frontend mapping** (`gui/frontend/src/api/threads.ts`): `ThreadView.inSidebar:
  boolean | null` (`s.inSidebar ?? null`); `stores/threadActions.ts`
  `THREAD_COMMANDS.sidebar` and `setThreadSidebar(id, shown)`. `stores/threads.ts`'
  `sameThread` needs nothing: the key is always present and compared with `===`.
  `src/api/settings.ts` does not enumerate keys.
* **Docs for agents**: see "Skill and guide" below.

## Confirm matrix (`thread.archive`, archiving)

"Working" for a hidden descendant is the root's own mid-turn rule (`midTurn`): STARTING,
or CONNECTED and BUSY, or NEEDS_ATTENTION with a `permission:` / `question:` reason. A
child's background agents or shells do not ask (only a turn or a prompt does).

| The thread itself | Hidden descendants taken along | Asks |
|---|---|---|
| idle / finished / failed / stopped | none, or none working | no |
| idle / finished / failed / stopped | 1 working | `Archive thread <name>? 1 hidden child thread is still working; archiving ends its turn and archives it too. To keep it, ask <name> to hand it over (code-foundry thread sidebar --shown=true) or show it in the sidebar first.` |
| idle / finished / failed / stopped | N working | `Archive thread <name>? N hidden child threads are still working; archiving ends their turns and archives them too. To keep one, ask <name> to hand it over (...) or show it in the sidebar first.` |
| mid-turn, background work, wake pending | none working | as before: `Archive thread <name>? Claude is still working; archiving ends the turn.` (etc.) |
| mid-turn, background work, wake pending | N working | both in one: `Archive thread <name>? Claude is still working; archiving ends the turn. N hidden child threads are still working; ...` |
| any | any | unarchiving: never asks, never cascades |

With `--ids` (several): the busy-threads text as before, plus the children's clause
(threads listed in `--ids` themselves are counted as listed threads, not as children;
"ask its creator to hand it over"). With `--ids` of one id: the single-thread question.
With `--descendants-of`: unchanged (it always confirms and lists every target; the
cascade's threads are among them, see below).

## `--descendants-of` and the cascade

`thread archive --descendants-of <root> [--include-root]` archives each subtree thread
through `ThreadService.Archive`, in tree order, so the daemon cascades from each of
them. A hidden thread the cascade already archived is then archived again by the
command's own call for it, which is a no-op (Close does nothing on a disconnected
thread, `archiveOne` sees `ArchivedAt` set and returns unchanged; nothing is logged or
published). The command's output lists each id once from its own list, so nothing is
double-counted; the daemon's `cascaded` count only counts threads it changed.

## Dock badge and attention counts

There is no badge or attention counter in the daemon: the Dock badge is
`gui/frontend/src/stores/dockAlerts.ts` (`attentionIds` in `stores/threads.ts`), fed by
the thread list and the settings, and `internal/presence` only tracks whether a window
is visible and key. `waiting.go`'s "waiting on N child threads" counts a thread's wake
subscriptions, not attention, and stays (decision 7). So decision 6 lands in PR 2: the
GUI's `attentionIds` must skip threads hidden by the rule.

## Skill and guide

Done last, after rebasing onto main with the orchestrate skill split (#264) in it.

* **`reference/sidebar.md`** (new, static, embedded): hidden by default and what that
  means (no sidebar, no Dock badge, the creator's Threads tab, you answer it), the
  override (`thread sidebar --shown=true|false`, `thread new --sidebar`, the list
  marks), the handover pattern and its reverse, and the archive cascade (hidden ones go
  along, shown ones stay, unarchive does not cascade, the confirmation, `--ids` and
  `--descendants-of` exact). SKILL.md (now 126 lines of the 130 cap): the intro no
  longer says the user sees every thread, the Archive step has one sentence on the
  cascade, "More" has the pointer. `skills_test.go`: the file in the rendered set and
  four pointer entries.
* **`reference/commands.md` is generated** from the registry (`internal/skills`
  `commandsReference`), so `thread.sidebar` and `thread new --sidebar` are in it with no
  edit.
* **The guide is split into topics.** On main it was ~28,990 of its 29,000 bytes; the
  registry alone (`thread.sidebar` and `thread.new --sidebar`, rendered from the
  commands) took it to 29,550 before any hand-written sentence. As agreed, nothing was
  trimmed: `code-foundry guide` now has the intro, Conventions (with the two new
  sentences) and the Thread commands in detail, then "More commands: `code-foundry guide
  <topic>`" with one line per other category naming each of its commands;
  `code-foundry guide <topic>` (`action`, `workspace`, `project`, `terminal`, `app`,
  `daemon`, `git`, `pull-request`, `settings`, `view`, `worktree`) prints that category
  with whole descriptions and one line per flag (the old guide had only first sentences
  for them, so the topics say more than before). An unknown topic exits 2 naming the
  topics. `internal/guide/topics.go`; `cmd/code-foundry/guide.go` takes the optional
  positional topic. `TestGuide` still checks every command is named in the guide, that
  every command's usage (with `--yes` exactly when it confirms) appears in the guide or
  its topic, the cap on the guide and on each topic, and that every topic is listed;
  `topics_test.go` covers names, an unknown topic and the guide's new size.

## Gotchas

* `thread.new` emits the focus intent for every thread it creates, a hidden child too
  (unchanged here): a GUI showing that intent opens a thread the sidebar does not list.
  PR 2 decides (probably: ignore focus for a hidden thread).
* The fake thread store's `Archive` does not cascade; tests of the cascade use the real
  store (`sidebar_test.go`).
* A new `thread.sidebar` arg `shown` is `Required` and Bool: `--shown` alone means true,
  `--shown=false` hides.

## Tests

* Store: `sidebar_test.go`: `TestInSidebar` (the rule table), `TestArchiveCascade` (the
  pure walk: setting off/on, a shown thread cutting its branch, through an archived
  hidden one, unknown and empty roots, a creator cycle), `TestFilterArchiveCascade`
  (archived left out, include archived, the setting, composing with created-by),
  `TestCascadeError`, `TestSetSidebar` (InvalidArgument on the user's thread, NotFound,
  published, persisted across restarts both ways), `TestCreateInSidebar`,
  `TestArchiveCascadeManager` (hidden child and grandchild archived and closed before
  the root, a shown child and its hidden child and an unrelated thread untouched,
  unarchive not cascading, `List(ArchiveCascadeOf)` and the exclusive-filter error, the
  setting on keeping a worker).
* Migration: `internal/db/thread_in_sidebar_migration_test.go`.
* Daemon: `TestApplyShowCreatedThreads`.
* API: `thread_sidebar_test.go` (mapping unset/false/true, SetSidebar codes, Create with
  and without a creator, the cascade filter with depths and totals, calls).
* Commands: `commands_thread_sidebar_test.go` (`thread.sidebar` messages and requests,
  required and typed `shown`; `thread.new --sidebar` true/false/absent, without a
  creator; `TestThreadArchiveHiddenChildren`: the confirm matrix above, ids, a listed
  child, unarchive), `commands_thread_archive_test.go` (requests now include the cascade
  list), `commands_thread_list_test.go` (marks), the registered-commands list.

## End to end (2026-10-20, isolated home, scratch project under ~)

`make build`; `CODE_FOUNDRY_HOME=/tmp/cf-hidden ./bin/code-foundry daemon --dev` (no
`CODE_FOUNDRY_*` in its environment); `~/cf-scratch-hidden` with a README. Every
`code-foundry` below is `./bin/code-foundry` with `CODE_FOUNDRY_HOME=/tmp/cf-hidden`.
Threads `claude-haiku-5-5[1m]` at medium; the children were made from the shell with
`--created-by` (what an agent's `thread new` sends). Output as printed.

```
$ code-foundry project add ~/cf-scratch-hidden
registered cf-scratch-hidden (a3107eff7ef4)
$ code-foundry settings get threads.show_created_threads
false
$ code-foundry thread new --project a3107eff7ef4 --model 'claude-haiku-5-5[1m]' --effort medium --name "hc parent" --prompt "Reply with the single word ready."
created thread hc parent (s-75a0bcf8d7b8) in /Users/alex/cf-scratch-hidden
$ code-foundry thread new ... --permission auto --name "hc hidden worker" --created-by s-75a0bcf8d7b8 --prompt @loop-prompt.txt
created thread hc hidden worker (s-e3225285f01e) in /Users/alex/cf-scratch-hidden     # runs a 240 s foreground loop
$ code-foundry thread new ... --name "hc handed over" --created-by s-75a0bcf8d7b8 --sidebar --prompt "Reply with the single word ready."
created thread hc handed over (s-09ae83a5d9dc) in /Users/alex/cf-scratch-hidden; shown in the sidebar
$ code-foundry thread new ... --name "hc under shown" --created-by s-09ae83a5d9dc --prompt ...
created thread hc under shown (s-bb00d9eb3414) in /Users/alex/cf-scratch-hidden
$ code-foundry thread new ... --name "hc toggled" --created-by s-75a0bcf8d7b8 --prompt ...
created thread hc toggled (s-b58d06fa4c5a) in /Users/alex/cf-scratch-hidden
$ code-foundry thread new --project a3107eff7ef4 --sidebar --prompt hi
code-foundry thread.new: only applies to a thread another thread creates (created-by, which defaults to $CODE_FOUNDRY_THREAD inside a thread); a thread you create is always shown
exit=2
$ code-foundry thread sidebar --id s-b58d06fa4c5a --shown=true
thread hc toggled (s-b58d06fa4c5a) shown in the sidebar
$ code-foundry thread sidebar --id s-b58d06fa4c5a --shown=false
thread hc toggled (s-b58d06fa4c5a) hidden from the sidebar
$ code-foundry thread sidebar --id s-75a0bcf8d7b8 --shown=true
code-foundry thread.sidebar: thread s-75a0bcf8d7b8: invalid argument: only a thread another thread created can be shown or hidden in the sidebar; one the user created is always shown
exit=2
$ code-foundry thread list
s-b58d06fa4c5a  attention (finished)  hc toggled        cf-scratch-hidden  now  [hidden]  ↳ hc parent
s-bb00d9eb3414  attention (finished)  hc under shown    cf-scratch-hidden  2s  ↳ hc handed over
s-09ae83a5d9dc  attention (finished)  hc handed over    cf-scratch-hidden  6s  [in sidebar]  ↳ hc parent
s-e3225285f01e  busy                  hc hidden worker  cf-scratch-hidden  8s  ↳ hc parent
s-75a0bcf8d7b8  attention (finished)  hc parent         cf-scratch-hidden  10s
$ code-foundry thread list --json | (id name createdBy inSidebar)
s-b58d06fa4c5a hc toggled s-75a0bcf8d7b8 False
s-bb00d9eb3414 hc under shown s-09ae83a5d9dc unset
s-09ae83a5d9dc hc handed over s-75a0bcf8d7b8 True
s-e3225285f01e hc hidden worker s-75a0bcf8d7b8 unset
s-75a0bcf8d7b8 hc parent - unset

$ code-foundry thread archive --id s-75a0bcf8d7b8 </dev/null
code-foundry thread.archive: Archive thread hc parent? 1 hidden child thread is still working; archiving ends its turn and archives it too. To keep it, ask hc parent to hand it over (code-foundry thread sidebar --shown=true) or show it in the sidebar first.
Re-run with --yes to confirm.
exit=2
# the parent sent the same loop prompt, now busy too:
$ code-foundry thread archive --id s-75a0bcf8d7b8 </dev/null
code-foundry thread.archive: Archive thread hc parent? Claude is still working; archiving ends the turn. 1 hidden child thread is still working; archiving ends its turn and archives it too. To keep it, ask hc parent to hand it over (code-foundry thread sidebar --shown=true) or show it in the sidebar first.
Re-run with --yes to confirm.
exit=2
$ code-foundry thread archive --id s-75a0bcf8d7b8 --yes            # 0.7 s
archived thread hc parent (s-75a0bcf8d7b8)
$ code-foundry thread list --all
s-75a0bcf8d7b8  idle                  hc parent         cf-scratch-hidden  now  [archived]
s-e3225285f01e  idle                  hc hidden worker  cf-scratch-hidden  now  [archived]  ↳ hc parent
s-b58d06fa4c5a  attention (finished)  hc toggled        cf-scratch-hidden  13s  [archived, hidden]  ↳ hc parent
s-bb00d9eb3414  attention (finished)  hc under shown    cf-scratch-hidden  15s  ↳ hc handed over
s-09ae83a5d9dc  attention (finished)  hc handed over    cf-scratch-hidden  19s  [in sidebar]  ↳ hc parent
# daemon log:
#   archived thread with the thread above it thread=s-e3225285f01e root=s-75a0bcf8d7b8 depth=1
#   archived thread with the thread above it thread=s-b58d06fa4c5a root=s-75a0bcf8d7b8 depth=1
#   archived thread thread=s-75a0bcf8d7b8 cascaded=2 cascade_failed=0
$ code-foundry thread archive --id s-75a0bcf8d7b8 --archived=false
unarchived thread hc parent (s-75a0bcf8d7b8)
$ code-foundry thread list                                        # the worker stays archived
s-75a0bcf8d7b8  idle                  hc parent       cf-scratch-hidden  3s
s-bb00d9eb3414  attention (finished)  hc under shown  cf-scratch-hidden  18s  ↳ hc handed over
s-09ae83a5d9dc  attention (finished)  hc handed over  cf-scratch-hidden  23s  [in sidebar]  ↳ hc parent
$ code-foundry thread get s-e3225285f01e --json | (state status reason archivedAt)
THREAD_STATE_DISCONNECTED THREAD_STATUS_IDLE archived 2026-10-20T07:34:03.364098Z

# daemon stopped (SIGTERM) and started again on the same home:
$ code-foundry thread list --all
s-75a0bcf8d7b8  idle                  hc parent         cf-scratch-hidden  16s
s-e3225285f01e  idle                  hc hidden worker  cf-scratch-hidden  16s  [archived]  ↳ hc parent
s-b58d06fa4c5a  attention (finished)  hc toggled        cf-scratch-hidden  29s  [archived, hidden]  ↳ hc parent
s-bb00d9eb3414  attention (finished)  hc under shown    cf-scratch-hidden  31s  ↳ hc handed over
s-09ae83a5d9dc  attention (finished)  hc handed over    cf-scratch-hidden  35s  [in sidebar]  ↳ hc parent

# the setting, live:
$ code-foundry settings set threads.show_created_threads true
$ code-foundry thread archive --id s-09ae83a5d9dc --yes            # log: cascaded=0
archived thread hc handed over (s-09ae83a5d9dc)
$ code-foundry thread list                                        # "hc under shown" is shown now: it stays
s-75a0bcf8d7b8  idle                  hc parent       cf-scratch-hidden  22s
s-bb00d9eb3414  attention (finished)  hc under shown  cf-scratch-hidden  37s  ↳ hc handed over
$ code-foundry settings set threads.show_created_threads false
$ code-foundry thread archive --id s-09ae83a5d9dc --archived=true --yes   # log: s-bb00d9eb3414 root=s-09ae83a5d9dc; cascaded=1
archived thread hc handed over (s-09ae83a5d9dc)

# --descendants-of with the cascade: each id once
$ code-foundry thread archive --ids s-09ae83a5d9dc,s-bb00d9eb3414,s-e3225285f01e,s-b58d06fa4c5a --archived=false
unarchived 4 threads: s-09ae83a5d9dc, s-bb00d9eb3414, s-e3225285f01e, s-b58d06fa4c5a
$ code-foundry thread archive --descendants-of s-75a0bcf8d7b8 --include-root --yes
archived 5 threads: s-75a0bcf8d7b8, s-e3225285f01e, s-09ae83a5d9dc, s-bb00d9eb3414, s-b58d06fa4c5a
# log: the root cascaded 2 (worker, toggled), "hc handed over" cascaded 1 (under shown);
# the command's own calls for those three were no-ops (nothing logged)

$ code-foundry guide | wc -c
21381
$ code-foundry guide pull-request | head -1
# code-foundry guide: Pull Request
$ code-foundry guide bogus
guide: no guide topic "bogus"; topics: action, workspace, project, terminal, app, daemon, git, pull-request, settings, view, worktree (thread commands are in the guide itself)
exit=2
```

No ERROR lines in either daemon log. The daemon was stopped, and `~/cf-scratch-hidden`,
`/tmp/cf-hidden` and `~/.claude/projects/-Users-alex-cf-scratch-hidden` deleted.

The first `guide <topic>` run printed `unknown command "guide pull-request"`: the CLI
hands a local verb followed by a word to the registry ("daemon status" is
`daemon.status`). `guide` is now the one local verb that takes a word
(`verbTakesWords` in `cmd/code-foundry/main.go`; CLI e2e cases added).

Not verified live: the GUI (no GUI change; PR 2).

Daemon restart needed: yes (migration 0040, new RPC, filter and commands, the archive
cascade).
