# App memory as a directory (2026-10-22)

The app memory (control-3-app-memory.md) was one `memory.md` of `- <text>` lines. It is
now a directory shaped like Claude Code's own memory: an index and one file per entry,
with provenance in frontmatter. Daemon, CLI, proto and the GUI's view models; no page (a
follow-up builds Settings › Memory on this).

## Decision

Alex, 2026-10-22: the memory stays markdown, not a database, and takes the shape Claude
Code uses for its own memory, so the model already knows it.

* **Provenance without polluting the prompt.** The Settings page needs when an entry was
  added and which thread added it. That lives in each file's frontmatter, and the prompt
  still gets only the bodies: the injected block, its heading and the hash-based
  re-injection on resume (control-6) are byte for byte what they were.
* **The familiar shape.** A model asked to look at the memory finds a `MEMORY.md` index
  and one small file per entry, the layout its own memory uses.

## Layout

```
<CODE_FOUNDRY_HOME>/memory/
  MEMORY.md                 # "- [<text>](<file>)" per entry, rewritten after every write, never read
  <slug>.md                 # one entry
```

```
---
created: 2026-10-22T17:37:48.270Z
thread: s-5f963f4547cc
thread_name: memory dir e2e
---
Always explain git terms when you use them
```

* **Slug**: lowercase ASCII letters and digits, any other run a dash, at most 48 bytes
  (cut at a dash past half way); nothing left is `entry`. A taken name gets `-2`, `-3`,
  .... `memory.md` is never used, because on a case-insensitive volume it is the index.
  A changed text is a new file (remove, then add).
* **created** is RFC 3339 UTC **to the millisecond** (`memory.CreatedLayout`), not to the
  second as the brief's example had it. Entries are ordered by `created`, then file name.
  With seconds, two adds in one second (a model saving two preferences in one Bash call)
  and every line of an import would sort by file name. An add always lands after the
  latest entry (at least one millisecond later), so the order is the order they were
  added in.
* **thread / thread_name**: written only when a thread added the entry. Values are YAML
  plain scalars, or double-quoted when they contain `:`, `#`, quotes and the like.
* **Writes**: each entry is a temp file in the directory (0600), then a rename. The
  directory is 0700, made on the first write. The index is rewritten the same way after
  every add, remove, clear and import. Remove deletes the file (every file holding that
  text, so a hand-made copy goes too). Clear deletes every entry file and leaves an
  empty index.
* **Reads tolerate hand edits**: every `*.md` but the index, dot files (a write's temp
  file) and directories. Frontmatter is a first `---` line up to the next `---` line;
  without the closing line the whole file is text. Unknown keys and a `created` that is
  not a time are ignored. The text is the rest, with comments, headings and blank lines
  dropped, joined onto one line and normalised. A file with no frontmatter is an entry of
  unknown provenance, ordered by its modification time. A file with no text is skipped
  (WARN). The same text in two files (any case) counts once.
* **Caps unchanged**: 40 entries, 4096 bytes of injected text (the bodies rendered as the
  prompt lists them), 500 characters per entry, with the same errors.
* A memory directory that is a symbolic link is written through. control-6 supported a
  linked `memory.md`; the import renames such a link itself, so a user keeping it in
  dotfiles links the directory instead.

## Import

`memory.Store.Import` runs at every daemon start (`internal/daemon/stores.go`) and does
nothing once `memory.md` is gone. It reads the file with the old lenient parser (CRLF,
blank lines, headings, comments and case repeats skipped; entries normalised). Every
line becomes an entry with `created` = the file's mtime (plus one millisecond per line,
so the order stays) and no thread. Then the file is renamed to `memory.md.imported`.

* A line with no letter or digit (`---`, `***`, `|---|`) is malformed: skipped, WARN.
* A line already in the directory is not written twice, so an import cut short (a crash
  between the entries and the rename) can run again.
* Lines past the caps are kept, as a hand edit is: show and remove see them, threads get
  the first ones within the caps.
* A failure (e.g. a directory named `memory.md`) is logged as a WARN. The file stays for
  the next start and the daemon runs on.

`TestImport` is the table: no file, order, empty file, hand edits, malformed lines,
invalid UTF-8, past the caps, cut short and run again, and a directory in the way.

## Snapshot, bus, API

* **Snapshot** (`memory.Snapshot`): the entries with provenance, how many are injected,
  their rendered bytes, the last read error, and a version. Every read (a spawn's
  `Injected`, a `show`) and write records one; one that differs from the last is
  published as `bus.Publish[memory.Event]` (`*Snapshot` is the only event: the whole
  memory, 40 short lines at most). So a hand edit reaches watchers on the next read; the
  directory is not watched.
* **MemoryService** (`proto/codefoundry/v1/memory.proto`, `internal/api/memory.go`):
  `Get` reads now; `Watch` sends a fresh read, then each published snapshot. Entries
  carry `file` (a stable key), `created`, `thread_id`, `thread_name` and `injected`
  (false past the caps), plus the three caps and the directory. Writes stay the
  `memory.*` commands.
* **EventService** source `EVENT_SOURCE_MEMORY` (16), `Event.memory` (17), sent after
  skill. The GUI holds one EventService stream, so the page will read it there, not
  open a MemoryService.Watch. Its snapshot is a fresh read too.
* Not a plugin event source (`pluginSources`): nothing asked for it, and the entries are
  the user's prompt text.
* **GUI**: `src/api/memory.ts` maps to `MemorySnapshotView` / `MemoryEntryView` (origin
  `{kind: "thread", threadId, threadName}` or `{kind: "user"}`). `toEventView` maps the
  source. The handler registry in `stores/events.ts` is total, so it has a no-op `memory`
  entry until the page lands. The mock daemon does not serve memory yet.

## Verbs

* `memory add` records the calling thread's id and current name (`$CODE_FOUNDRY_THREAD`
  through the CLI, as before). From the user's terminal or the GUI no thread is recorded.
  An unnamed thread records its id and no name. A thread the store no longer has records
  its id. Child threads stay refused (control-6).
* `memory show --json`, and the entry in `add --json` and `remove --json`, gain
  `created`, `thread_id` and `thread_name` (always present, "" when unknown). The plain
  output is unchanged.
* `memory remove` and `memory clear` are unchanged.

## Skills

Unchanged. No skill text (code-foundry, code-foundry-help, ember rules and skill) names
the memory's path or calls it "the file": they speak of `memory add|show|remove` and of
the model's own memory files.

## End to end (2026-10-22, isolated home)

`make build`; the daemon with `CODE_FOUNDRY_HOME=/tmp/cf-memdir`, the branch's `bin` first
on `PATH` and no `CLAUDE*`/`CODE_FOUNDRY_*` variables. Seeded `memory.md` (mtime
2026-10-01 09:00 local):

```
# My preferences
- Always open PRs as drafts
---
- Never open the side panel on your own.
- always open prs as drafts
```

At start: WARN "import skipped a malformed line" line=`---`, then "imported the single
memory file into the directory" entries=2 skipped=1. The home had `memory.md.imported`
and `memory/` with `MEMORY.md` plus the two entry files (`created:
2026-10-01T14:00:00.000Z` and `.002Z`, no thread). `memory show` printed the two numbered
lines.

A thread (`--no-project`, `claude-haiku-5-5[1m]`, medium, named "memory dir e2e") got
"From now on, always explain git terms when you use them." It ran `code-foundry memory
add "Always explain git terms when you use them."` by itself. The new file has `thread:
s-5f963f4547cc` and `thread_name: memory dir e2e`, the index gained the third line, and
`memory show --json` showed `"thread_id":"s-5f963f4547cc","thread_name":"memory dir e2e"`
on it.

A second thread started afterwards: its spawn argv ended "...say which is which):\n-
Always open PRs as drafts\n- Never open the side panel on your own\n- Always explain git
terms when you use them", and asked to list its preferences without a command, it gave
those three. `MemoryService/Get` over the TCP port returned the three entries with
`file`, `created`, the thread's id and name on the third, `injected: 3`,
`injectedBytes: 113`, and the caps.

No ERROR lines. The daemon was stopped; the two transcripts, `/tmp/cf-memdir` and the
launcher script were deleted.

## Left out

* The Settings › Memory page (the follow-up), and the mock daemon's MemoryService.
* The directory is not watched (FSEvents): a hand edit shows up with the next read.

## Daemon restart

Needed: the memory store, the import at start, MemoryService and the EventService
source, and the verbs' JSON are all in the daemon (the GUI and CLI ship with it).
