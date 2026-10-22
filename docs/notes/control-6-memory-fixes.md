# App memory fixes (2026-10-22)

Testers ran the app memory (control-3-app-memory.md) and found eight problems. Daemon,
CLI, one proto field and skill text; no GUI change.

## 1. A changed memory reaches running conversations

control-3 claimed a restart or fork picks up a changed memory. It does not: Claude
records the `--append-system-prompt` on a conversation's first request and reuses it on
`--resume`, so only a fresh session (create, reseed, an Ember epoch) got the change.

* **The hash**: `threads.memory_hash` (migration 0046, `Thread.MemoryHash`) identifies the
  entries the conversation last got: sha256 of the entries joined by newlines, 16 hex
  digits; "" for none. Only the entries count, so rewording a heading resends nothing.
* **Every spawn** (`claudeCommand`, through `memorySpawned`): a fresh conversation
  (`launch.resume == ""`) has the memory in its system prompt and the row takes its hash
  (in `spawn`'s commit, or the effort restart's update when the conversation was never
  saved). A resumed one (start on send, `thread restart`, effort restart, fork, recreate)
  whose hash differs gets `runner.memNote`: the whole list again,

  ```
  Updated standing preferences for code-foundry (replace the earlier list):
  - <entry>
  ```

  or, for an emptied memory, "Updated standing preferences for code-foundry: there are
  none now (forget the earlier list)."
* **Delivery** (`runner.sendMessage`): the note goes first in the next message Claude
  gets, whoever sends it (the user, a wake, another thread), before a seed prefix or
  resume note. The row takes the hash only once it went out (`memorySent`), so a process
  that dies first leaves the next spawn to try again.
* **Not in the message**: the user item keeps the text as typed; the note is on
  `Item.MemoryNote` (items JSON `memory_note`), like `SeedPrefix`, which the GUI does not
  render either. Nothing new to show: the toast (below) already told the user.
* **A fork** copies its parent's hash: it resumes the parent's conversation.
* **Unreadable memory** on a resumed spawn changes nothing (no "none now" note): the
  error is logged, as before.
* **Existing rows** have "", so a thread from before this change gets the list once on
  its next message after a restart, if the memory has entries. Harmless: it says
  "replace the earlier list".

Running threads are not refreshed mid-process; the idle stop at cache expiry restarts
most of them soon enough, which is what "after a restart" in the messages means.

## 2. Who can write the memory

`memory.add`, `memory.remove` and `memory.clear` look up the calling thread (the CLI's
`$CODE_FOUNDRY_THREAD`; `ActiveView` empty) with `ThreadService.Get`:

* a thread with `created_by` (a worker, a hidden child) is refused with PermissionDenied:
  "memory is written from the user's own threads only: thread X was started by thread
  Y; tell that thread instead". `memory.show` still works there.
* a successful add or remove from one of the user's threads emits a `ui.notify` toast
  (info): "Remembered: <text>" / "Forgot: <text>", body `By thread "<name>".` (title
  clipped to 120 characters). The GUI and the user's own terminal change it silently.
* the store logs `by=<thread id>` on every add, remove and clear ("" outside a thread);
  a refusal logs a WARN with the thread and its creator.
* a thread the store no longer has (a stale environment) counts as the user's; any other
  lookup error fails the command without changing anything.

The GUI's palette sends its active thread as context, so it is never treated as a
thread's call (only the CLI is).

## 3. Ember

Ember saved a standing preference with `ember remember`, which only its own MEMORY.md
keeps, so its workers never saw it. Its rules (`internal/store/ember/files/rules.md`),
skill ("Memory and epochs", one line paid by reflowing the paragraph; 204 of 205 lines)
and the `ember.remember` description now send preferences about how threads behave to
`code-foundry memory add`; `ember remember` is for Ember's own working notes.

## 4. MemoryHeading

"What you remember about the user's standing preferences for code-foundry (kept with
`code-foundry memory show|add|remove`; the user asking what you remember, to remember
something, or to forget something means this list, not your own memory files):". The
ambiguous "they apply here before any other instruction" is gone.

## 5. Per-entry cap

`memory.MaxEntryChars` = 500 characters (runes), checked in `Clean`: "an entry is at most
500 characters and this one has N; say it shorter or split it in two" (an argument
error). The 40-entry and 4 KiB caps keep "memory is full".

## 6. Hand-edited files

`Parse` skips CRLF, blank lines, markdown headings (1 to 6 `#` then a space or nothing;
"#hashtag" is an entry), and `<!-- -->` comments (multi-line ones too; one left open runs
to the end). Every entry is normalised (`Normalize`): trimmed, each run of white space
one space, a leading "- " dropped, a sentence's full stop dropped (an ellipsis stays, so
normalising twice changes nothing). Repeats (any case) count once. `Add` normalises
before its duplicate check, so "- Always open PRs as drafts." is a duplicate of "Always
open PRs as drafts".

`Store.Injected` (what the daemon passes as `thread.Options.Memory`) caps what threads
get at the first 40 entries within 4 KiB rendered and logs a WARN when the file holds
more; `show`, `remove` and `Texts` still see every entry, so the user can trim it.

## 7. Verb ergonomics

* **Several words**: a new `ArgSpec.Rest` (proto `ArgSpec.rest`, field 14): the last
  positional takes every bare word left, joined by spaces (`cmd/code-foundry`
  `assignPositionals`). Registration refuses it on a non-string, non-positional or
  not-last positional arg. `memory add always open PRs as drafts` and `memory remove
  side panel` need no quotes.
* **remove**: digits in range are an index; otherwise the entry whose text it is
  (normalised, any case), then the one entry containing it. Digits out of range that no
  text matches are the range error; "100" removes "Keep lines under 100 characters".
* **Errors name the path once**: `fileErr` unwraps `*fs.PathError` and `*os.LinkError`
  ("memory: read /…/memory.md: is a directory").
* **Symlinks**: a memory file that is a symbolic link is written through (temp file and
  rename beside the target), so the link stays; an emptied memory empties the target
  instead of removing the link. A link to a missing file is refused: "memory: <path> is a
  symbolic link to <dest>, which does not exist; create that file or remove the link".

## 8. Wording

* add: `Remembered: "<text>". New threads will follow it; threads already open get it on
  their next message after a restart.`
* duplicate: `Already remembered: "<text>" (nothing changed).`
* remove: `Forgot: "<text>".`
* clear: `Forgot 3 preferences.` / `No preferences to forget.`; its confirmation says
  "New threads get none."
* `daemon.capabilities --group memory` says new threads get the list and threads already
  open get a change with their next message after a restart.

`show` keeps its numbers; no message says "#3" any more.

## End to end (2026-10-22, isolated home)

`make build`; the daemon with `CODE_FOUNDRY_HOME` in a scratch directory, the branch's
`bin` first on `PATH` and no `CLAUDE*`/`CODE_FOUNDRY_*` variables; a scratch git repo
under `$HOME` added as a project (`project.add` refuses /tmp); `claude-haiku-5-5[1m]`,
medium.

```
$ code-foundry memory add The codeword is PELICAN
Remembered: "The codeword is PELICAN". New threads will follow it; threads already open get it on their next message after a restart.
$ code-foundry thread new --project <id> --model 'claude-haiku-5-5[1m]' --prompt "Reply with just OK."   # OK
$ code-foundry memory remove PELICAN && code-foundry memory add The codeword is ALBATROSS
$ code-foundry thread restart --id <t> && code-foundry thread send --id <t> "what is the codeword? ..." --wait
#5 you: what is the codeword? Answer with the word only.        (shown as typed)
#8 claude: ALBATROSS
```

The transcript's user message began "Updated standing preferences for code-foundry
(replace the earlier list):\n- The codeword is ALBATROSS\n\n"; the daemon logged "sent the
changed app memory with the resumed conversation's next message" once. (Haiku also ran
`memory show` before answering, seeing two lists; the answer was right.) Then the entry
became CORMORANT and `thread fork` of that thread answered "CORMORANT" without a command.

A child thread (`--created-by` the first) asked to run `code-foundry memory add Always use
tabs` got exit 1: "memory is written from the user's own threads only: thread … was
started by thread …; tell that thread instead (permission_denied)", and the daemon logged
the refusal (WARN). The same add from the user's thread logged `by=<its id>`. No ERROR
lines. The threads, their transcripts, the scratch repo and the home were deleted after.
The toast was checked by the unit tests only (no GUI attached).

## Left out

* The help skill (code-foundry-help) still says a preference "applies to threads started
  from now on"; another PR owns that text and ThreadPrompt's routing.
* No GUI for the memory, and the memory note on a message is not rendered.

## Daemon restart

Needed: migration 0046, the spawn and send paths, the memory verbs and the CLI's
positional handling (the GUI and CLI ship with the daemon).
