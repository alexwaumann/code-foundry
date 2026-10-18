# Lineage by id: the creator's current name everywhere (2026-10-18)

Thread lineage (`agents-2-metadata.md`, `agents-3-lineage-gui.md`) showed the creator under
the name it had when it created the thread (`created_by_name`) and, in the "Created by"
note, linked by matching that name against the thread list. Alex decided (2026-10-18) that
everything resolves the creator by its stable thread id and shows its current name; the
recorded name stays only as the fallback for a creator that no longer exists. The format
has not reached a stable release: no shim for old notes beyond graceful fallback. Wake
notes (`agents-4-wake.md`) already worked this way and are the model.

## Decisions

From the brief:

* **`NoteItem.created_by`** (proto field 2): the creator thread's id on the "Created by"
  note the daemon writes at the top of an agent-made thread; empty on every other note
  (fork notes, agent-finished notes). In the store it is `Item.NoteCreatedBy`, persisted
  in the item data JSON as `note_created_by` (omitempty): no SQL migration.
* **The note text is unchanged**: "Created by <name at creation> · brief: <brief>". It is
  the plain-text fallback for `thread read` and for a removed creator.
* **A fork's copy carries the id** (`forkItems` copies whole items), so it links by id too.
* **GUI**: `Creator` is `{ id, name, exists }`, `name` the creator's current name (its id
  while unnamed, the sidebar's `name || id`), else the recorded `createdByName`, else the
  id. The chip, the row tooltip, the Threads panel's subline and Created by section, and
  the note all go through it, so a rename re-renders all of them. The "(removed)" tooltip
  wording and the panel's inert "Removed" row are unchanged.
* **The note row is keyed on the item's `createdBy !== ""`**, not on its id
  (`note-created-by`) or its text. `CREATED_BY_NOTE_ID` is gone from the GUI (nothing else
  used it); the daemon keeps `createdByNoteID` as the item id.

Decided while building (flagged for review):

* **`thread get` shows the current name too.** It has only the one thread in hand, so it
  makes one extra call to the existing `ThreadService.List` (filter `all`) to resolve the
  creator; no new RPC. A creator not in that list is removed: the line reads
  `created by: <recorded name> (<id>, removed)`. The brief allowed keeping the recorded name
  there; the live check asked for the new name, and one list call is cheap.
* **`thread list` resolves from its own result first** and makes the same one unfiltered
  list call only when a listed thread's creator is not in the result (a filter such as
  `--created-by <id>`, `--status`, the default archived cut or `--limit` left it out, or it
  was removed). The shared helpers are `threadNames` and `creatorName` in
  `commands_thread_list.go`.
* **`--json` output is unchanged**: it still carries `createdByName` as recorded; scripts
  wanting the current name look the id up.
* **`useNoteCreator(createdBy, recorded)`** returns a `Creator` (shallow over id, name and
  exists) rather than an id: the row needs the current name and whether to link, and the
  shallow compare is what makes a rename re-render the note. `lib/lineage.noteCreator` and
  `creatorOf` share one resolver.
* **`parseCreatedByNote(text)` splits at the first " · brief: "** (no name matching, never
  null). A creator name containing that separator splits early, which only shows for a
  removed creator: an existing one is shown under its current name.
* **Mock**: `s-l-grand` records its creator as "Add retry to login redirect (old)", so the
  e2e sees the current name before removal and the recorded one after.

## What changed

* `proto/codefoundry/v1/thread.proto` `NoteItem.created_by`; `make gen` (Go + TS).
* `internal/store/thread`: `items.go` `Item.NoteCreatedBy`; `items_db.go`
  `note_created_by`; `metadata.go` `startNote` takes the note `Item` (it was id + text);
  `manager.go` `Create` sets `NoteCreatedBy: creatorID`.
* `internal/api/thread.go`: `NoteItem.CreatedBy` from `NoteCreatedBy`.
* `internal/command`: `commands_thread_list.go` (`threadNames`, `creatorName`,
  `formatThreadList` takes the names), `commands_thread_metadata.go` (`threadDetail` takes
  them; `thread.get` resolves).
* GUI: `src/api/thread.ts` (`note.createdBy`), `src/lib/lineage.ts`,
  `src/stores/lineage.ts`, `src/components/thread/rows.tsx` (`SystemNoteRow` dispatch,
  `CreatedByNoteRow`), doc comments in `SidebarRow.tsx` and `ThreadParts.tsx`;
  `mock/thread.ts` (`SeedHistory.note.createdBy` into the proto), `mock/world.ts`.

## Gotchas

* A "Created by" note written by a daemon before this change has no `created_by`: the GUI
  now draws it as the plain centred divider with its text, not the lineage line. Only tip
  builds wrote such notes.
* The sidebar row tooltip does not open over the selected row in e2e: hover before
  opening the thread.
* `thread rename` takes `--id` and `--name` flags, not positionals.

## Tests

* Go: `metadata_test.go` (the note carries the creator id, after a restart too; an unnamed
  creator's; a fork's copy carries it, before and after a restart), `fork_test.go`
  (`forkItems` keeps it), new `items_db_test.go` (round trip of a created-by note, a fork
  note and a wake message), `internal/api/thread_test.go` (the mapping), CLI
  `commands_thread_list_test.go` (renamed creator, a creator not in the list looked up,
  removed keeps the recorded name) and `commands_thread_metadata_test.go` (get: current
  name, unnamed creator, removed).
* Unit (vitest): `lib/lineage.test.ts` (renamed, unnamed, removed creators;
  `parseCreatedByNote`; `noteCreator` by id with a namesake), `lineageRows.test.tsx`
  (renamed creator linked by id and a live rename, unnamed, removed, a fork's copy by id
  whatever has the name, a note without an id stays the divider), `ThreadParts.test.tsx`
  (chip shows the current name and follows a rename), `surfaces/threads.test.tsx` (subline
  current name, follows a rename), `api/thread.test.ts` (`createdBy` mapped).
  `SidebarRow.test.tsx`, `stores/threads.test.ts` and `api/threadMetadata.test.ts` needed
  no change (no tooltip unit test exists; the e2e covers it).
* e2e `lineage.spec.ts`: new "a renamed creator" test (tooltip, chip, note link by id with
  the current name, the link opens it); the removed-creator test now expects the recorded
  "(old)" name on the chip and the note.

## Verification

* `make check` green.
* `make gui-e2e` for `lineage.spec.ts`, `thread.spec.ts` and `agents-panel.spec.ts`
  (the specs with notes), WebKit and Chromium: 84 passed, 12 skipped (screenshots).
* Live, 2026-10-18: `make build`, `CODE_FOUNDRY_HOME=/tmp/cf-lbi.YgS5/home ./bin/code-foundry
  daemon --dev`, the CLI with the same home (`code-foundry` below is `./bin/code-foundry`).
  The parent's Claude (Haiku 5.5, medium) ran `thread new` itself:

```
$ code-foundry thread new --no-project --model 'claude-haiku-5-5[1m]' --effort medium --name "lbi parent" --created-by= \
    --prompt "Run exactly this shell command once and then stop: code-foundry thread new --no-project --model 'claude-haiku-5-5[1m]' --effort medium --brief 'greet and stop' --prompt 'say hi and stop'"
created thread lbi parent (s-dcc718507d3f) in /Users/alex (no project)
$ code-foundry thread wait s-dcc718507d3f --until attention --for 3m
thread s-dcc718507d3f lbi parent: needs attention (finished)
$ code-foundry thread list
s-dcc718507d3f  attention (finished)  lbi parent  no project  2s
s-76b0047647e7  attention (finished)  (unnamed)   no project  3s  ↳ lbi parent
$ code-foundry thread rename --id s-dcc718507d3f --name "lbi parent renamed"
renamed thread lbi parent renamed (s-dcc718507d3f)
$ code-foundry thread list
s-dcc718507d3f  attention (finished)  lbi parent renamed  no project  20s
s-76b0047647e7  attention (finished)  (unnamed)           no project  20s  ↳ lbi parent renamed
$ code-foundry thread list --created-by s-dcc718507d3f      # the creator is filtered out: looked up
s-76b0047647e7  attention (finished)  (unnamed)  no project  20s  ↳ lbi parent renamed
$ code-foundry thread get s-76b0047647e7
thread s-76b0047647e7
status: needs attention (finished)
worktree: /Users/alex
created by: lbi parent renamed (s-dcc718507d3f)
brief: greet and stop
cost: $0.0015
$ code-foundry thread get s-76b0047647e7 --json | jq -c '{id, createdBy, createdByName, brief}'
{"id":"s-76b0047647e7","createdBy":"s-dcc718507d3f","createdByName":"lbi parent","brief":"greet and stop"}
$ code-foundry thread read s-76b0047647e7 | head -1
#1 note: Created by lbi parent · brief: greet and stop
$ code-foundry thread items --id s-76b0047647e7 --json | jq -c '.items[0].note'
{"text":"Created by lbi parent · brief: greet and stop","createdBy":"s-dcc718507d3f"}
$ code-foundry thread fork --id s-76b0047647e7 --name "lbi fork"
forked s-76b0047647e7 into lbi fork (s-d65d0848b9e2)
$ code-foundry thread items --id s-d65d0848b9e2 --json | jq -c '[.items[] | select(.note) | .note]'
[{"text":"Created by lbi parent · brief: greet and stop","createdBy":"s-dcc718507d3f"},{"text":"Forked from s-76b0047647e7"}]
$ code-foundry thread remove --id s-dcc718507d3f --yes
removed thread s-dcc718507d3f
$ code-foundry thread list
s-d65d0848b9e2  idle                  lbi fork   no project  6s
s-76b0047647e7  attention (finished)  (unnamed)  no project  36s  ↳ lbi parent
$ code-foundry thread get s-76b0047647e7
...
created by: lbi parent (s-dcc718507d3f, removed)
...
```

  The threads were removed and the daemon stopped afterwards; the home deleted.
* Not verified live: the GUI against the live daemon (the mock e2e covers it; Alex takes the
  screenshots).

Daemon restart: needed. A GUI against an older daemon gets notes without `createdBy` and
draws the Created by note as the plain divider (the chip, tooltip and panel still work and
show current names).
