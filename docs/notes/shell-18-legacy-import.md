# Shell PR 18: import the old panel and terminal state (daemon half)

The daemon half of the first-load import (`shell-model.md`, "First load for an existing user";
`shell-plan.md` section 3 and PR 18). The classic window's side panels and bottom terminals
become each thread's remembered set and quick terminal, once. No thread is opened, and a classic
user's layout is left as one empty space, which draws the composer. Running terminals keep
running. The GUI half (calling it once before the shell first draws) is PR 20.

Section 3 of the plan was written before the first-load rule changed. Its step 4 (open the last
viewed thread) and its `last_thread_id` input are gone: every thread is handled as its step 5
says. `thread_info_open` is not an input either: no step used it.

## What is in it

| Where | Holds |
| --- | --- |
| `internal/layout/legacy_panel.go` | a Go port of the side panel store's rehydrate: the zustand envelope, migrations V1 to V5, `sanitizePanelState`, `tabId` |
| `internal/layout/legacy.go` | `ImportLegacy` (pure): the stores, the thread list and the terminal list to the new state; `readBottom` |
| `internal/layout/testdata/legacy/panel.json` | 57 stored values and what the TypeScript store held after rehydrating each |
| `internal/store/layout` | `Store.ImportLegacy`, `ImportCommit`, the `legacy_import` mark in `layout_meta`, `Snapshot.LegacyImported`, `Delta.LegacyImported`; the fake does the same |
| `proto/codefoundry/v1/layout.proto` | `LayoutService.ImportLegacy`, `Layout.legacy_imported = 6`, `LayoutDelta.legacy_imported = 8` |
| `internal/api/layout.go` | the handler; `LegacyImporter`, `Layout.WithImporter` |
| `internal/daemon/layout_import.go` | `legacyImport`: reads threads and terminals, commits, labels the quick shells |
| `internal/store/terminal` | `Store.SetLabels` (manager and fake): labels change on the actor and are published; the process is not touched |

## The import, as built

The inputs are the raw `code-foundry.panel` and `code-foundry.bottom` values, every thread with
its archive state, and every terminal with its labels, start time and whether it exited.

1. **The stores.** The panel value goes through the port of the store's rehydrate: a numeric
   version below 6 is migrated as the store migrates it, and everything is repaired with
   `sanitizePanelState`. A missing or non-numeric version, or 6 and above, is only repaired.
   Anything that is not JSON is no store. The bottom value is read as its store reads it: version
   1 (or none), `open` exactly true, a positive height.
2. **What the layout already holds.** A space with a thread tab open was arranged with the new
   verbs and is not touched. In every other space:
   - a linked tab of a thread that lives in that space is taken out and folded into that thread;
   - an unlinked terminal tab (a project's shell, a free shell) is taken out, and its terminal
     keeps running;
   - every other tab stays (a composer or draft, a page, a linked tab of a thread living in
     another space).
   A folded tab of an archived or removed thread, or of a terminal that no longer exists, is
   dropped.
3. **Each live thread, in id order.** Its remembered set gains, after what it already remembers:
   - its side panel's tabs, the first group and then the second;
   - the non-terminal tabs folded in step 2;
   - its terminals, oldest first: the shells, action runs and setups its bottom panel showed,
     the same `IsPanel` kinds and `thread` label as `ownerKeyOf`.
   A tab is skipped when its surface is open in the thread's space or remembered already. A
   folded terminal tab is reused, keeping its id and name. Kinds map one to one (`files` to
   `file`, `ember` to `ember.board`, `plugin.*` as is). A kind the shell has no surface for, or a
   tab its kind refuses (a pull request with a bad number, a diff without a checkout), is dropped
   and listed. The records have no pane (`remembered.pane` and each `pane` are ""), so opening
   the thread places them fresh: the first gets a new pane to the right when there is room, and
   the rest join it.
4. **The quick terminal.** If the thread has no running quick shell, its oldest running shell
   that no open or remembered tab shows becomes the quick shell. That shell is not also a tab:
   its folded tab, if any, is discarded. When the thread has no quick record yet, the bottom
   entry gives `quick.open` (only when the thread has a quick shell) and `quick.height`.
5. **Archived and gone threads** keep nothing: their panel entries are dropped and listed. Keys
   that are not `thread:<id>` (pages, composers) are ignored.
6. **Commit.** `Store.ImportLegacy` runs the pure import, writes the result and
   `legacy_import = done:<unix ms>` in one transaction, and publishes one event (op
   `import_legacy`, delta with `legacy_imported`). It does this even when the layout did not
   change, as on a fresh install. Then the daemon labels each new quick shell
   `termlabel.QuickShell` (`slot=quick`). Once the mark is set, a call changes nothing and
   answers `imported: false` with the layout as it is.

The import's event carries an empty `core.Result`, so the glue ends nothing. Tabs taken out are
reported in the response (`removed_tab_ids`, `folded_tab_ids`), not as `Closed`. A folded or
remembered terminal is held by the layout (`core.Holds`). A terminal that is taken out has no
tab, and the glue never ends a terminal it does not hold.

## Telling automatic tabs from an arrangement

Until the cutover, the classic window's `terminal.new` and `terminal.new-free` give every shell a
layout tab, placed by the rules (PR 6). PR 7 makes the item verbs a model calls (`view.panel.*`)
place linked tabs too. In both cases the thread's own tab is never open: the classic window never
opens a thread tab. A space that holds a thread tab was arranged by someone using the new verbs
(`thread.open`, the shell window behind its flag). Such a space is left exactly as it is, and its
threads' legacy tabs are only remembered.

So the rule never loses what matters:

- **No running terminal ends.** Nothing is closed through a path the glue reacts to. A terminal
  that loses its tab either goes into a remembered set (it comes back with its thread) or is a
  shell with no thread, which keeps running with no tab.
- **No arrangement is lost.** A space with a thread tab is untouched. In other spaces only linked
  tabs of the space's own threads move into the set that brings them back beside the thread, and
  unlinked shells lose their tab. A linked tab of a thread living elsewhere was dragged there by
  hand (open_surface places a thread's tabs in its own space), so it stays. Composers, drafts and
  pages stay.

## Decisions to confirm

1. **Shells that belong to no thread** (the Projects page's bottom panel, free shells) get no
   tab, as the spec gives them none. They keep running. A user can still list them with
   `code-foundry terminal list` (directory and what runs in each), type a command into one with
   `code-foundry terminal rerun <id> --command …`, and end them with `code-foundry terminal
   close`; nothing in the window shows them. In the shell they can be reached once a surface lists unlinked
   terminals (the plan's step 6 put them under the Projects surface's "+"; that is GUI work, not
   built). The other choice was to keep their tabs
   in one pane, which the spec's empty first space rules out.
2. **An exited action run or setup comes back as a remembered terminal tab**, not only running
   terminals as the plan said. The bottom panel showed it so its output could be read and closed.
   Without a tab it would stay in the terminal store with no way to close it from the window. An
   exited shell is never the quick terminal (a shell is removed when it exits anyway).
3. **A thread whose tab is already open** (an arranged space) gets its legacy tabs as a
   remembered set. They come back the next time it closes and opens, rather than being placed
   now, which would change an arrangement someone made.
4. **The import relabels a shell**, the first write outside the layout store. It is a label on the
   terminal (`slot=quick`) because everything that finds a quick terminal (`terminal.quick`,
   `terminal.new --quick`, the glue, the GUI later) reads the label. The terminal store gains
   `SetLabels`, which publishes the change and does not touch the process.
5. **The order in a set**: side panel tabs, then folded views, then terminals. Each group's active
   tab is recorded as `active`, but records placed fresh do not use it: the first placed tab ends
   up active in its pane.
6. **Where the TypeScript would throw on a malformed store older than version 3** (a tab without
   params, an entry without a tab list), it keeps nothing. The port keeps the entries and tabs
   that are sound (`TestReadPanelKeepsWhatIsSoundInABrokenOldStore`). Every case the TypeScript
   handles matches it exactly.

## Verification

- `make check` green.
- **The port pinned to the TypeScript**: `testdata/legacy/panel.json` was captured by a throwaway
  vitest file (not committed). The file wrote each stored value to `localStorage`, ran
  `usePanelStore.persist.rehydrate()`, and recorded `byKey`. The inputs are those of
  `panel.test.ts` and `panel.migrate.test.ts` (versions 1 to 5, the `{}` groups store, the junk
  store, newer versions), plus a missing version, a string version, a null state, a null store,
  an array, text that is not JSON, and an empty value. `TestReadPanelMatchesTheTypeScript`
  compares all 57. Breaking one rule of the port (keeping `focused` when a split folds) fails 4 of
  them. PR 21 deletes the TypeScript; the fixtures stay as its record.
- **The import table** (`legacy_test.go`): a fresh install; threads with zero, one and three
  terminals; archived, snoozed and removed threads; pages and composers; a thread already with a
  quick shell; an exited action run; classic shells' automatic tabs (folded, taken out, a tab of
  a gone terminal and one of an archived thread dropped, and the space empty); an arranged space
  left untouched, with dedupe against open and remembered tabs; a dormant tab in another space
  kept. Also every captured store run as a thread's panel (`{}` groups, absent, garbage: nothing),
  the tabs as they were (kind, title, params, key, active), and the import then `open_thread`:
  the set placed beside the thread, the same terminals held, the quick terminal open at its old
  height.
- Store: once only, the mark written and reloaded, a second call publishing nothing, a fresh
  install as a commit, a focus change still waiting written with the import, after `Close`. API:
  the handler over the fake, the second call, Unimplemented without an importer, and the delta's
  mark. Terminal store: `SetLabels` on a running `cat` (same pid, event published, own copy).
  Daemon: `TestLegacyImportEndsNothing` runs with the glue. Automatic tabs leave, the first shell
  is labelled quick, and after a later commit the glue has handled, every terminal still runs.
  Opening the thread brings its terminal tab back. Ran with `-race -count=3`.

### End to end with the built binary

`make build`, a daemon on `CODE_FOUNDRY_HOME=$(mktemp -d /tmp/cf18.XXXX)` (stopped and removed
afterwards). The scratch pad's own path is too long for a Unix socket (103 bytes on macOS). The
client is a 40-line Go program that posts Connect JSON to `LayoutService/ImportLegacy` over the
daemon's socket. Threads A (`s-78b6…`), B (`s-cc3a…`) and C (`s-7dbf…`, archived) have no project.

```
$ code-foundry terminal new --context-thread s-78b6ba4f0ca9     # three times, a second apart
created terminal t-462663a48d98; tab t-t4jxcnqg in pane p-umcvben5
created terminal t-e31fdb1e5e67; tab t-eba527ib in pane p-umcvben5
created terminal t-d01f106d5a54; tab t-vq7pcsbk in pane p-umcvben5
$ code-foundry terminal new --context-thread s-cc3a0cd14cbe
created terminal t-08649f626e9e; tab t-ueuze7dm in pane p-umcvben5
$ code-foundry terminal new-free
created terminal t-4ec00d337320 in /Users/alex; tab t-bsvxyxih in pane p-umcvben5
$ code-foundry thread archive s-7dbf59b7fa02
$ code-foundry terminal rerun t-e31fdb1e5e67 --command "sleep 900"
$ code-foundry layout show                      # what the classic window's shells left: tabs nobody saw
rev 5, laid out in 1180x820
space sp-sfurszu7 "Main" (current) (default: threads with no space live here)
  pane p-umcvben5 (focused)
      t-t4jxcnqg terminal of s-78b6ba4f0ca9 "Legacy A" terminal t-462663a48d98
    * t-bsvxyxih terminal terminal t-4ec00d337320
      t-ueuze7dm terminal of s-cc3a0cd14cbe "Legacy B" terminal t-08649f626e9e
      t-vq7pcsbk terminal of s-78b6ba4f0ca9 "Legacy A" terminal t-d01f106d5a54
      t-eba527ib terminal of s-78b6ba4f0ca9 "Legacy A" terminal t-e31fdb1e5e67
$ ps -o pid,ppid,command | awk '$2==<daemon> && $3=="/bin/zsh"' > pids.before   # 71024 71152 71263 71385 71394
$ importcli panel.json bottom.json
```

`panel.json` is a version 3 store. For A, group 0 holds a Usage tab, a file and a Worktree tab
of `web` at `/tmp/web`, and group 1 a pull request `Octo/Web#7`. B has an MCP tab. C (archived)
has a file, and `view:projects` has `{}` groups. `bottom.json` gives A open at 240 and B closed
at 300.

```
{
  "dropped": ["thread s-7dbf59b7fa02 is archived or gone: its side panel is dropped"],
  "foldedTabIds": ["t-t4jxcnqg", "t-ueuze7dm", "t-vq7pcsbk", "t-eba527ib"],
  "imported": true,
  "layout": {"currentSpaceId": "sp-sfurszu7", "defaultSpaceId": "sp-sfurszu7", "legacyImported": true, "rev": "6"},
  "removedTabIds": ["t-bsvxyxih"],
  "threads": [
    {"quickTerminalId": "t-462663a48d98", "tabIds": ["t-yx3lgjzh", "t-vny3hone", "t-tzigorur", "t-eba527ib", "t-vq7pcsbk"], "threadId": "s-78b6ba4f0ca9"},
    {"quickTerminalId": "t-08649f626e9e", "tabIds": ["t-mtpbg5rx"], "threadId": "s-cc3a0cd14cbe"}
  ]
}
$ code-foundry layout show
rev 6, laid out in 1180x820
space sp-sfurszu7 "Main" (current) (default: threads with no space live here)
  (no panes)
threads
  thread s-78b6ba4f0ca9 "Legacy A" in space sp-sfurszu7, quick terminal open
    remembered t-yx3lgjzh file of s-78b6ba4f0ca9 "notes.md" in pane
    remembered t-vny3hone diff of s-78b6ba4f0ca9 "Diff · web" in pane
    remembered t-tzigorur pullrequest of s-78b6ba4f0ca9 "#7" in pane
    remembered t-eba527ib terminal of s-78b6ba4f0ca9 terminal t-e31fdb1e5e67 in pane
    remembered t-vq7pcsbk terminal of s-78b6ba4f0ca9 terminal t-d01f106d5a54 in pane
  thread s-cc3a0cd14cbe "Legacy B" in space sp-sfurszu7
    remembered t-mtpbg5rx mcp of s-cc3a0cd14cbe "MCP" in pane
$ code-foundry terminal list
ID              STATE    CWD          RUNNING    LABELS
t-462663a48d98  running  /Users/alex  -          kind=shell project= slot=quick thread=s-78b6ba4f0ca9 worktree=/Users/alex
t-e31fdb1e5e67  running  /Users/alex  sleep 900  kind=shell project= thread=s-78b6ba4f0ca9 worktree=/Users/alex
t-d01f106d5a54  running  /Users/alex  -          kind=shell project= thread=s-78b6ba4f0ca9 worktree=/Users/alex
t-08649f626e9e  running  /Users/alex  -          kind=shell project= slot=quick thread=s-cc3a0cd14cbe worktree=/Users/alex
t-4ec00d337320  running  /Users/alex  -          kind=shell
$ diff pids.before pids.after && echo "same shell processes"
same shell processes
$ importcli panel.json bottom.json              # again: nothing changes, imported is false (left out)
{"layout": {"currentSpaceId": "sp-sfurszu7", "defaultSpaceId": "sp-sfurszu7", "legacyImported": true, "rev": "6"}}
$ grep 'imported the classic' logs/daemon.log
{"level":"INFO","msg":"layout: imported the classic panels","store":"layout","threads":2,"quick":2,"folded":4,"removed":1,"dropped":["thread s-7dbf59b7fa02 is archived or gone: its side panel is dropped"]}
$ code-foundry thread open s-78b6ba4f0ca9
opened thread s-78b6ba4f0ca9 as tab t-hgwdtlcy in pane p-k7mhlxiz of space sp-sfurszu7; 5 linked tabs came back
$ code-foundry layout show
rev 7, laid out in 1180x820
space sp-sfurszu7 "Main" (current) (default: threads with no space live here)
  row s-h4edajyl [0.65 0.35]
    pane p-k7mhlxiz (focused)
      * t-hgwdtlcy thread s-78b6ba4f0ca9 "Legacy A"
    pane p-hjbib3zu
      * t-yx3lgjzh file of s-78b6ba4f0ca9 "Legacy A" "notes.md"
        t-vny3hone diff of s-78b6ba4f0ca9 "Legacy A" "Diff · web"
        t-tzigorur pullrequest of s-78b6ba4f0ca9 "Legacy A" "#7"
        t-eba527ib terminal of s-78b6ba4f0ca9 "Legacy A" terminal t-e31fdb1e5e67
        t-vq7pcsbk terminal of s-78b6ba4f0ca9 "Legacy A" terminal t-d01f106d5a54
threads
  thread s-78b6ba4f0ca9 "Legacy A" in space sp-sfurszu7, quick terminal open
  thread s-cc3a0cd14cbe "Legacy B" in space sp-sfurszu7
    remembered t-mtpbg5rx mcp of s-cc3a0cd14cbe "MCP" in pane
$ code-foundry terminal quick s-78b6ba4f0ca9 --open
opened thread s-78b6ba4f0ca9's quick terminal t-462663a48d98 (nothing changed)
$ diff pids.before pids.after2 && echo "same shell processes"
same shell processes
$ kill <daemon>; sqlite3 db.sqlite "select key, value from layout_meta order by key"
current_space|sp-sfurszu7
default_space|sp-sfurszu7
legacy_import|done:1794498116202
rev|7
$ code-foundry daemon --dev &; importcli panel.json bottom.json     # after a restart: still a no-op
{"layout": {..., "legacyImported": true, "rev": "10"}}
```

The rev after the restart is 10 because the start sweep dropped the tabs of the shells that died
with the old daemon (PR 6). No warning or error in the daemon log.

## Gotchas

- zustand's persist migrates only a numeric version that differs from the store's. A missing or
  string version goes straight to the repair, and a version 7 or 9 store is only repaired. The
  port follows that (the cases "no version" and "a version that is a string").
- The panel store's `tabId` uses `encodeURIComponent`. The port escapes every byte but
  `A-Z a-z 0-9 - _ . ! ~ * ' ( )` with upper-case hex. The sorted key order matches JavaScript's
  for these ASCII param names.
- `ImportLegacy` takes the used ids before any tab leaves the tree, so a new remembered tab never
  reuses the id of a folded one that has not been put back yet.
- `layout show` prints "in pane" with nothing after it for a record with no pane. The text is
  made by `commands_layout_threads.go` (internal/command), which this PR does not touch; see
  below.

## Version window

- New fields only. An older GUI ignores `legacy_imported`, and nothing calls `ImportLegacy` yet.
  The mock daemon (`gui/frontend/mock/layout.ts`) does not serve it; connect's router answers
  Unimplemented.
- A GUI of PR 20 against a daemon before this PR gets Unimplemented. `SHELL_SINCE` (PR 20)
  already sends that window to the update dialog.

## For later PRs

- **PR 20** (the GUI calls it): before the shell first draws, when the layout snapshot says
  `legacy_imported` is false, call `LayoutService.ImportLegacy` once with
  `panel_json = localStorage["code-foundry.panel"] ?? ""`,
  `bottom_json = localStorage["code-foundry.bottom"] ?? ""` (the raw strings, not the stores'
  state: the daemon runs the migrations) and the window's `client_id`. Draw from the
  `layout` in the response (or the next delta, which carries `legacy_imported: true`). Leave both
  keys in localStorage (plan section 3). A second window, or a retry after a lost response, gets
  `imported: false` and the layout. Do not import in the classic window.
  The mock needs an `ImportLegacy` that sets `legacyImported` (the import's logic stays in Go;
  the mock can return the layout unchanged).
- **The `layout show` text** (`internal/command/commands_layout_threads.go`) should say "placed
  fresh beside the thread" instead of "in pane" with nothing after it, and may print the import
  mark.
- **Unlinked shells with no tab** (decision 1): a surface that lists a project's or a free
  shell's terminals (the Projects surface's "+", or a terminal picker in the pane "+") is the
  only way the window can reach them.
- **PR 21** deletes `panel.ts` and its tests. `testdata/legacy/panel.json` is then the only
  record of what the old stores held. Keep it as long as the import runs.
- **PR 23** (architecture doc): `LayoutService.ImportLegacy`, `legacyImport` and
  `terminal.Store.SetLabels`.
