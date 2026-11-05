# Editing a file: the agent (PR 3 of 3)

`view.panel.file <path> --edit [--line N] [--note "..."]` asks the user to edit a file: the tab
opens editing under a band, and Save and tell thread writes, then sends the thread "I saved
.env. Continue without reading its values." The agent never gets the contents from this. It is
for a value the agent should not handle, not a privacy boundary: a thread holds the daemon's full
token and can read most files itself, and nothing here says otherwise. A thread told only "I saved
config/new.env." read the file straight away, which is why the message says what it says: an
instruction to the model, not a claim to the user.

## Files

| Path | What |
| --- | --- |
| `internal/fsx/editable.go` | `Writer.Editable`: Write's reach, then the rule of the GUI's `canEdit` |
| `internal/command/commands_view_items.go` | `--edit`, `--note`, `editCheck` |
| `gui/frontend/src/stores/fileRequest.ts` | the request's life: Save and tell, Dismiss, what cmd+S and the close dialog mean |
| `gui/frontend/src/components/files/FileRequestBand.tsx` | the band |
| `gui/frontend/src/stores/fileEdit.ts` | `creating`, the palette's editor, reads held by the find field |
| `gui/frontend/src/lib/plainText.ts`, `plainNote` in the verb | what model text may show |

## Decisions

* **The request lives in the tab's params** (`edit`, `askId`, `asker`, `note`, `askSaved`), persisted with
  the panel. It has to wait for a tab that is not on screen, and a thread waiting on a band must
  not lose it to a window reload. Finishing drops the params; nothing else remembers it, so a
  reload or a reopened tab finds nothing. `recentFiles` keeps only the path.
* **Opening the file another way keeps the request** (a path chip, `--line` without `--edit`):
  `openFileInPanel` carries it, as it does a page. A new request replaces it, and never touches a
  session, so a draft stays. Each request has its own id, made when the intent lands, so one
  with the same note is still new: it turns editing back on after the pencil turned it off.
* **Model text gets no layout of its own.** A note can be written by a prompt injection, and a
  thread's name by the model. The verb collapses a note to one paragraph and strips control,
  format and bidi characters and all but 3 combining marks in a row, then counts the 500. The band
  does the same to the note and the name, whatever reached it, quotes the name, cuts it at 48
  characters, sets the note as a quotation in a box that scrolls, and keeps the buttons outside it.
* **A request behind the editor in use.** Without `--focus`, a request that would swap the document
  the user is typing in joins the strip behind it (`openTabBehind`); the tab strip shows it. Only
  `--edit`: a plain `view.panel.file` opens as it always has.
* **The asker is the caller.** `--thread B` from thread A opens in B's panel, and A is named and
  told. From the CLI outside a thread it is the panel's thread.
* **The request ends before the send,** after the write stood, so two presses cannot send twice.
  A failed send is then a failure band ("Saved, but X was not told: why") and the request is over:
  the user can say it in the thread. A close dialog that saved but could not tell keeps the tab,
  to show that.
* **"Saved" must be true.** `askSaved` records that a write landed since this request. Save and
  tell needs something to write, or that: after row two's Save or Overwrite it only tells. On a
  clean document with no write it is off, and cmd+S does nothing, as anywhere; Dismiss is there
  for a file that needed nothing. The flag is in the params, so it survives a reload and a new
  request starts without it.
* **Where the file really is.** ReadFile reports `real_path` and `mode`, and while a request is
  up the band states it when a symlink leads elsewhere and when group or others can read the
  file. A warning and a fact, not a refusal, and no claim either way about the agent.
* **While the band is up, Save and tell has the chord.** cmd+S and the palette's Save File do it
  and the close dialog's button says it. Row two's Save writes alone and shows no chord then: two
  buttons showing ⌘S would be a lie.
* **New file.** Any request whose read finds nothing, so a file deleted between the verb and the
  tab can still be answered. The session is `creating` over `blankFile`, an empty text view. The
  save goes with `create`, so a file that appeared meanwhile is a conflict; Overwrite goes with
  `force`. A read that finds nothing is expected, one that finds a file raises the conflict, and a
  clean document follows it. `findMissing` is off for a request's tab: a namesake is not the file
  asked for. No pencil and no Rendered: there is no viewer to go back to.
* **The verb reads the file, the daemon only.** Invalid UTF-8 and a BOM need the bytes, up to the
  1 MiB the tab edits. They stop in `Editable`. A refusal names the path and which rule failed,
  with no contents and no exact size. That still tells the agent one bit about a file it may not
  read (over 1 MiB, binary, not UTF-8, a BOM), the price of a clear refusal, accepted. Beyond the
  brief it also refuses what would leave a dead tab: an image (an SVG is text), a read-only file, a
  symlink leading nowhere (`create` could never succeed), a FIFO.
* **`--line` in the editor.** `selectedLines` stays on while a request is up and the document is
  untouched (`CodeFileEdit.mark`); otherwise the only selection is the caret's, as before.
* **`--focus` is the one way a thread takes the keyboard.** The daemon adds `focus=1` to the
  params, which the intent spends at once and never stores in the tab, so a reload takes nothing.
* **`--edit`'s CLI message says what to do next** ("end your turn, a message says when it is
  saved"), fixed text. `--json` is unchanged.

## Telling the model

The skill alone did not route it. Sonnet 5.5 at medium effort in a scratch repo, "set my Stripe
key in .env, then run check.js": no skill loaded, and it told the user to paste the key into the
file by hand. So `ThreadPrompt` gained "secrets: view.panel.file --edit --note, not chat", inside
its 1,641-byte cap at 1,638, paid for by dropping `usage or worktree` from its panel verbs (both
verbs are gone), "thread's", "Here: ", "to " and " for app questions" (it did not fit back). "never
suggest /model" and "never hand-made worktrees or branches" stay as they were: the second is a
phrase a model cited as its reason for routing (`orch-skill-v2.md`). An earlier cut of them was
reverted, and the clause tightened instead.

With the clause, all three runs loaded the entry skill and ran `--edit`, one of them after making
the missing file itself. On the final wording: told "I saved .env. Continue without reading its
values.", the thread ran check.js and did not read the value. An orchestration-shaped prompt (two
changes, a branch each) still loaded the orchestrate skill and worked through child threads. A few
runs, not a measurement.

The entry skill's description gained "a secret or a file you cannot read"; to fit its cap it
rewords the rest. Its row is paid for by one line of "Showing things". The line caps pass while
the bytes grew: the file went from 7,912 to 8,172.

## The three review fixes

* **Palette.** `fileEdit.ts` notes the editor with the keyboard when `palette.open` turns on,
  before the palette mounts. Save File and its listing use it. `returnFromPalette` puts the
  keyboard back a frame after the close: the palette's own return stops at the panel's aside.
* **Find field.** A clean re-read remounts the editor, which would close the field. With the
  keyboard in the field the read is held and looked at every 200 ms until the field lets go. The
  library's field closes with no event anyone outside can hear (Esc leaves the keyboard on the
  body, with or without this PR), and no `onFocus` fires, hence the check. It runs only while a
  read is held. A later save or re-read makes a held read stale; a replace in the field makes the
  document dirty, and the held read is then a conflict.
* **Failed list.** `dropPanelDrafts` runs only while `availability` is not "unavailable". A list
  that answers without a thread still counts as its removal.

## Gotchas

* A held read drops when a clean tab leaves: landing it would put contents back in a session with
  no editor.

* `thread.send` to a removed thread is not an error: it answers with the thread's report and exit
  code 1, and `InvokeResultView` dropped the code, so the composer path read it as sent. Only the
  real daemon showed this; the mock throws. `exitCode` is on the view now and
  `deliverThreadPrompt` fails on it.
* `sendErrorMessage` says "your message is kept", true of a composer's draft and not here, so
  the band uses `errorMessage`.

## Limits

* **The note stays in localStorage** on a tab nobody finished, until the tab closes. It is model
  text, never the file's.
* **A new `.env` is not gitignored** because the tab made it: the mode is 0600 and git will still
  show it.
* **A child thread's request.** A thread's panel only shows when the thread does, and children
  are not in the sidebar, so a child's `--edit` waits unseen. Like every panel verb.
* **No window open:** the verb says nothing was shown, and the request is gone.
* **Two windows** each hold the request; finishing it in one leaves the other's band up.
* A dirty New file's draft is lost on reload, like every draft; the tab comes back empty.

## Checked

Vitest and Go table tests; each of 17 mutations of the rules above fails a test, among them the
`--focus` gate, which an editor left over from an earlier test used to hide. `e2e/file-request.spec.ts`
for the keyboard, the mark, the find field and a hostile note. A scratch dev daemon (own
`CODE_FOUNDRY_HOME`, repos under home, WebKit on it) took the real CLI: all refusals and a
501-character note; `.env` kept at 0600 with the value on line 2; a missing `config/new.env` made at
0600; a message starting a stopped thread and reaching a busy one mid-turn; a pending request
surviving a reload and a dismissed one not; a removed asker's failure band with the save standing;
60 newlines and U+202E in a note, leaving a 163px band; a `.env` symlink to a 0644 file, with both
facts shown and the save landing in the target; cmd+S on it untouched doing nothing; row two's Save
turning Save and tell on; a repeat request, same note, after the pencil. No marker reached the
daemon's log or its home.

Not tested: the Wails window (everything ran in WebKit), and the real config home from the CLI,
which the Go tests cover with the real floor.
