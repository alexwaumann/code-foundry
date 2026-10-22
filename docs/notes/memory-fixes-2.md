# App memory fixes, round 2 (2026-10-22)

A test fan-out on main at #325 found eight problems with the app memory and its Settings
page (memory-dir.md, memory-page.md). Daemon, CLI, two proto fields per message, the page,
the guide and Ember's text.

## 1. Forget removes the right entry, and hand edits show up

The page sent `memory.remove {entry: "<index>"}` from its last snapshot. The directory was
not watched, so after a hand edit the snapshot was stale and Forget removed whatever entry
held that position now: data loss.

* **Ids.** An entry's id is its file name without `.md` (`memory.Entry.ID`). The proto
  `MemoryEntry.id` (8) and the verbs' JSON (`id`) carry it.
* **`memory remove --id <id>`** names an entry by id only (`Store.RemoveID`). An id no
  longer in the directory is refused with NotFound ("there is no entry X now; it was
  removed or its file renamed") and nothing changes. `--id` and the positional entry are
  exclusive; one of them is needed (the positional is no longer `Required`, so the usage
  line reads `memory.remove [<entry>]`). An id matches any file of an entry, so a copy made
  by hand names it too, and both files go, as before.
* **Detect by shape, too.** The positional entry also takes an id: digits in range are
  still an index, then the exact text, then an id, then a substring. So `memory remove
  use-tabs` works, and every existing behaviour is unchanged (an id is tried before the
  substring only, and only an exact id matches).
* **The page** forgets by id (`runCommandForResult("memory.remove", {id})`). NotFound is
  expected there: it toasts "That entry is gone; the list was refreshed." and reads the
  memory again (`loadMemory`). Any other failure is the usual error toast.
* **The directory is watched** (`internal/store/memory/watch.go`): fsnotify, as the
  settings store watches `settings.toml`, not the project store's FSEvents stream. One
  directory of at most 40 small files does not need FSEvents' recursion; kqueue has no
  cgo, so no goroutine has to own a cgo stream, and fsnotify was already a dependency. A
  change to an entry file (not the index, not a write's dot file) is debounced 100 ms,
  then `Load` reads the directory, which publishes the snapshot if it changed; the
  store's own writes come back as events too and publish nothing. A directory that is not
  there yet (it is made on the first write) or that went away is looked for every 2 s and
  watched once it appears; removing it publishes an empty memory. The watch runs for the
  daemon's lifetime, not only while a page is open: an idle kqueue watch costs nothing, and
  a spawn reads the directory anyway.
* `Load` now takes the write lock, so a read the watch triggers mid-write cannot publish a
  snapshot that the write's own later read already replaced.

The window between a hand edit and the page updating is now the debounce plus a read; the
id makes the remaining race harmless.

## 2. Import and add agree on what an entry is

* `Normalize` strips a leading `* ` or `+ ` bullet as it did `- `; a bullet alone is "".
* **An entry needs at least one letter or digit** (`memory.WellFormed`, `memory.NoLetter`).
  `Clean` refuses anything else with exactly those words ("an entry needs at least one
  letter or digit"): `***`, `* ---`, an emoji alone, a bullet alone. Whitespace alone is
  still "an empty entry".
* `Parse` returns the malformed lines with the entries; `Import` counts each one in
  `Skipped` and logs the same WARN ("import skipped a malformed line", now with
  `why=<NoLetter>`). Before, a bare `-` was dropped by `Normalize` and never counted.
* An entry file whose text has no letter or digit is skipped on read (WARN), as one with no
  text was.

## 3. Entries past 500 characters are listed, not injected

Only an import or a hand edit makes one. `markInjected` sets `Entry.Injected` and
`Entry.LeftOut` on every read: an entry longer than `MaxEntryChars` is left out on its own
(`too_long`) and does not count towards the caps; of the rest, the longest prefix within
40 entries and 4 KiB is injected, the rest left out (`entries` or `bytes`, as before).
`Store.Injected` (the spawn's list) and the snapshot both come from it. Proto
`MemoryEntry.left_out` (9) says why; `injected` is now per entry rather than "the first
N".

* `memory show` marks such a line: `2. <text> [not given to threads: longer than 500
  characters; remove it and say it shorter]` (or "past the 40-entry limit", "past the 4 KiB
  limit"); its JSON has `injected` and `left_out`.
* **The page had no not-injected state** (the brief assumed it did; `injected` was mapped
  but never rendered). A left-out row now has muted text and an amber caption line with an
  `EyeOff` icon: "Not given to threads: longer than 500 characters. Forget it and say it
  shorter." / "past the 40-entry limit." / "past the 4 KiB limit." `data-injected` on the
  row.
* `Add`'s caps are unchanged: the 40-entry and 4 KiB checks count every entry in the
  directory, a too-long one too.

## 4. A full memory is not a usage error

`ErrFull` went out as a bare FailedPrecondition, which the CLI reports as a usage error:
exit 2 and "Run `code-foundry help memory.add` for usage". It is now `command.Failed`, the
path for a command's own state errors: FailedPrecondition with a CommandFailed detail, so
the CLI prints the message and exits 1 with no pointer to help. (A busy `thread archive`
is a confirmation, not a failure, so the model to copy was the other state errors that go
through `Failed`.)

## 5. Page copy, the confirm button, search

* Footnote: "Applies to new threads at once, and to open threads with their next message
  after a restart." (the CLI's `memoryApplies` says the same).
* **Confirm buttons.** The dialog's button was the command's full title ("Memory: Forget
  All Preferences"). General fix: `Command.ConfirmLabel` (Go) → `ConfirmationRequired.
  confirm_label` (proto, 7) names the words when a command wants its own; otherwise the GUI
  uses the title without a "Category: " prefix (`confirmButtonLabel`), so every "Ember: …"
  and "Git: …" command's button lost its prefix too. `memory.clear` sets "Forget all".
  Registration refuses a `ConfirmLabel` without `Confirm`.
* **Search keywords.** `SettingSectionView.keywords` (optional, GUI pages only; the Skills
  sections have none) is part of what `searchGuiPages` matches. Memory › Remembered has
  "forget", "preferences", "standing", "remember".

## 6. Guide

`docs/GETTING-STARTED.md` (which the in-app Guide tab bundles, so one edit covers both):
the remembering paragraph now says "standing preference" and that Settings › **Memory**
lists them, with when and by which thread, and forgets one or all.

## 7. Two MEMORY.md files

Ember's rules ("Where things are") call its file "Ember's own MEMORY.md under
residents/ember" and say it is not `memory/MEMORY.md`, the app memory's index. The Ember
skill's "Memory and epochs" paragraph says "Ember's own MEMORY.md under residents/ember"
(reflowed: still 5 lines, the file still 204 of 205; rules.md 5,763 of 6,144 bytes). No
file was renamed.

## 8. Slugs

`slug` maps the common Latin letters with diacritics to ASCII before slugging (a table in
`entryfile.go`: à…ą → a, ç → c, ñ → n, ß → ss, æ → ae, œ → oe, ł → l, þ → th, and so on):
"naïve café" is `naive-cafe.md`. With 2, emoji-only or punctuation-only text never reaches
`slug`, so `entry.md` is left for text in another script (CJK, Cyrillic), which `slug`
cannot spell in ASCII.

## Tests

* Go: `TestParse` (bullets, malformed lines), `TestNormalize`, `TestAdd` (`NoLetter`
  cases), `TestSlug` (diacritics), `TestInjectedCaps` (per-entry reasons; too long alone;
  too long not counted), `TestRemove` (ids), `TestRemoveID` (the stale list: a gone id is
  refused and changes nothing; the next id removes the right entry; a hand-made copy),
  `TestWatch` (a directory made after the watch, add, in-place edit, delete, the whole
  directory removed and made again), `TestImport` (star and plus bullets, a bare `-`
  counted), command tests (`--id`, both/neither, `ConfirmLabel`, `show` marks, the cap as
  a command failure), CLI `TestCLIMemory` (`--id` gone, no letter, 41st add exits 1 with no
  usage hint), API (`id`, `left_out`, `confirm_label`).
* vitest: the row's left-out lines, Forget by id, a gone id refreshing, another failure
  not mistaken for a gone entry, the footnote; `confirmButtonLabel`; search by keywords;
  the mapping (and an older daemon without `id`/`left_out`).
* e2e `memory.spec.ts`: Forget sends `id`; a stale list (`?drop=…&quiet=1` in the mock)
  says the entry is gone and refreshes, then the next Forget takes the right row; a
  700-character entry's row; the Forget all button reads "Forget all"; search finds the
  page by "forget", "preferences", "standing". `SHOTS=<dir>` also writes `memory-long-*`.

## End to end (2026-10-22, isolated home)

`make gui-build`; the daemon with `CODE_FOUNDRY_HOME` in a scratch directory and no
`CLAUDE*`/`CODE_FOUNDRY_*` variables. The home held a legacy `memory.md`: a heading,
`* Use tabs in Go files`, `+ Keep answers short`, `-`, `***`, `- Prefer naïve café wording
in docs`, `- 🚀`, a 700-character line and `- Always open PRs as drafts`.

* At start: three WARNs "import skipped a malformed line" (`-`, `***`, `- 🚀`, each
  `why="an entry needs at least one letter or digit"`), one "imported an entry longer than
  an add allows; threads do not get it" (chars=700), then entries=5 skipped=3. Files:
  `use-tabs-in-go-files.md`, `keep-answers-short.md`, `prefer-naive-cafe-wording-in-docs.md`,
  `always-write-very-detailed-commit-messages-that.md`, `always-open-prs-as-drafts.md`.
* `memory show`: line 4 ends `[not given to threads: longer than 500 characters; remove it
  and say it shorter]`; `--json` gives it `injected: false, left_out: "too_long"` and every
  entry its id. `memory add '* ---'`: "an entry needs at least one letter or digit".
* The built Wails app on the same home opened Settings, and its search found Memory by
  "standing". Opening the hit from the keyboard did not work (the known, separate issue)
  and synthetic clicks were refused, so the page was then driven as memory-page.md did:
  the branch's GUI on the Vite dev server against the same daemon, Playwright in WebKit.
* With the page open, `keep-answers-short.md` was deleted by hand: the row vanished
  179 ms later. Forget on "Prefer naïve café wording in docs" then removed that entry and
  no other; `memory show` agreed (Use tabs, the long one, Always open PRs).
* A stale row: a file written by hand, its row shown, the file deleted and Forget clicked
  within the watch's debounce. The page toasted "That entry is gone; the list was
  refreshed." and the other rows stayed. `memory remove --id stale-one` afterwards:
  "there is no entry stale-one now; it was removed or its file renamed". `memory remove
  use-tabs-in-go-files` (an id as the entry) removed it.
* Forget all's dialog button read "Forget all". The long entry's row: muted text and the
  amber "Not given to threads: longer than 500 characters. Forget it and say it shorter."
  (the PR's screenshots, dark and light).

No ERROR lines in the daemon log. The daemon and Vite were stopped and the scratch home
deleted.

## Left out

* Haiku sometimes not saving "from now on" preferences (routing; tracked separately) and
  keyboard navigation of settings search results in the Wails app.
* The help skill still tells a thread to `memory remove <number>` after `memory show`; a
  thread does both in one turn, so the stale-list race is the page's, and the other agent
  owns that skill's text this round.

## Daemon restart

Needed: the store, the watch, the verbs, both protos and the confirm label are in the
daemon (the GUI and CLI ship with it).
