# Editing a file: the agent (PR 3 of 3)

`view.panel.file <path> --edit [--line N] [--note "..."]` asks the user to edit a file: the tab
opens editing under a band, and Save and tell thread writes, then sends the thread "I saved
.env." The agent never gets the contents from this. It is for a value the agent should not
handle, not a privacy boundary: a thread holds the daemon's full token and can read most files
itself, and nothing here says otherwise. A thread with no such instruction, told "I saved
config/new.env.", read the file straight away.

## Files

| Path | What |
| --- | --- |
| `internal/fsx/editable.go` | `Writer.Editable`: Write's reach, then the rule of the GUI's `canEdit` |
| `internal/command/commands_view_items.go` | `--edit`, `--note`, `editCheck` |
| `gui/frontend/src/stores/fileRequest.ts` | the request's life: Save and tell, Dismiss, what cmd+S and the close dialog mean |
| `gui/frontend/src/components/files/FileRequestBand.tsx` | the band |
| `gui/frontend/src/stores/fileEdit.ts` | `creating`, the palette's editor, reads held by the find field |

## Decisions

* **The request lives in the tab's params** (`edit`, `create`, `asker`, `note`), persisted with
  the panel. It has to wait for a tab that is not on screen, and a thread waiting on a band must
  not lose it to a window reload. Finishing drops the params; nothing else remembers it, so a
  reload or a reopened tab finds nothing. `recentFiles` keeps only the path.
* **Opening the file another way keeps the request** (a path chip, `--line` without `--edit`):
  `openFileInPanel` carries it, as it does a page. A new request replaces it, and never touches a
  session, so a draft stays.
* **The asker is the caller.** `--thread B` from thread A opens in B's panel, and A is named and
  told. From the CLI outside a thread it is the panel's thread.
* **The request ends before the send,** after the write stood, so two presses cannot send twice.
  A failed send is then a failure band ("Saved, but X was not told: why") and the request is over:
  the user can say it in the thread. A close dialog that saved but could not tell keeps the tab,
  to show that.
* **A clean document can still tell.** The user may have used row two's Save, or Overwrite, or
  the file may have needed nothing. Otherwise the thread would wait for ever. With no file yet
  there is nothing to say, so New file waits for something typed, and a conflict is settled first.
* **While the band is up, Save and tell has the chord.** cmd+S and the palette's Save File do it
  and the close dialog's button says it. Row two's Save writes alone and shows no chord then: two
  buttons showing ⌘S would be a lie.
* **New file.** The session is `creating` over `blankFile`, an empty text view. The save goes with
  `create`, so a file that appeared meanwhile is a conflict; Overwrite goes with `force`. A read
  that finds nothing is expected, one that finds a file raises the conflict, and a clean document
  follows it. `findMissing` is off for such a tab: a namesake is not the file asked for. No pencil
  and no Rendered: there is no viewer to go back to.
* **The verb reads the file, the daemon only.** Invalid UTF-8 and a BOM need the bytes, up to the
  1 MiB the tab edits. They stop in `Editable`. Every refusal names the path and the reason, never
  a size or a byte. Beyond the brief it also refuses what would leave a dead tab: an image (an SVG
  is text), a read-only file, a symlink leading nowhere (`create` could never succeed), a FIFO.
* **`--line` in the editor.** `selectedLines` stays on while a request is up and the document is
  untouched (`CodeFileEdit.mark`); otherwise the only selection is the caret's, as before.
* **`--focus` is the one way a thread takes the keyboard.** The daemon adds `focus=1` to the
  params, which the intent spends at once and never stores in the tab, so a reload takes nothing.
* **`--edit`'s CLI message says what to do next** ("end your turn, a message says when it is
  saved"), fixed text. `--json` is unchanged.

## Telling the model

The skill alone did not route it. Sonnet 5.5 at medium effort in a scratch repo, "set my Stripe
key in .env, then run check.js": no skill loaded, and it told the user to paste the key into the
file by hand. So `ThreadPrompt` gained one clause, inside its 1,641-byte cap, paid for by dropping
`usage or worktree` from its panel verbs (both verbs are gone), " for app questions", " or
branches" and a few words. The same prompt then loaded the entry skill, ran `--edit --line 2
--note`, ended its turn, and on "I saved .env." ran the check without printing the value. A second
prompt, with the file missing, went the same way, though it made the file itself first. That is
three runs, not a measurement.

The entry skill's description gained "a secret or a file you cannot read"; to fit its cap it
rewords the rest. Its row is paid for by one line of "Showing things".

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

* `thread.send` to a removed thread is not an error: it answers with the thread's report and exit
  code 1, and `InvokeResultView` dropped the code, so the composer path read it as sent. Only the
  real daemon showed this; the mock throws. `exitCode` is on the view now and
  `deliverThreadPrompt` fails on it.
* `sendErrorMessage` says "your message is kept", true of a composer's draft and not here, so
  the band uses `errorMessage`.

## Limits

* **A child thread's request.** A thread's panel only shows when the thread does, and children
  are not in the sidebar, so a child's `--edit` waits unseen. Like every panel verb.
* **No window open:** the verb says nothing was shown, and the request is gone.
* **Two windows** each hold the request; finishing it in one leaves the other's band up.
* A dirty New file's draft is lost on reload, like every draft; the tab comes back empty.

## Checked

Vitest and Go table tests as listed in the PR; each of 8 mutations of the rules above fails a test.
`e2e/file-request.spec.ts` for the keyboard, the mark and the find field. A scratch dev daemon
(own `CODE_FOUNDRY_HOME`, repos under home, WebKit on it) took the real CLI: all refusals and a
501-character note; `.env` kept at 0600 with the value on line 2; a missing `config/new.env` made at
0600; "I saved config/new.env." starting a stopped thread; a message reaching a busy thread
mid-turn; a pending request surviving a reload and a dismissed one not; a removed asker's failure
band with the save standing. No marker reached the daemon's log or its home.

Not tested: the Wails window (everything ran in WebKit), and the real config home from the CLI,
which the Go tests cover with the real floor.
