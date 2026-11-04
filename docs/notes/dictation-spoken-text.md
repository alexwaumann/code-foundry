# Dictation: spoken symbols, spoken formatting, Advanced (2026-11-04)

PR 1 of three (then Other audio, then Microphone). Two settings that turn spoken words into
text, and the Advanced disclosure under the Dictation card that they live in.

## What shipped

* `internal/dictate/spoken.go`: `Spoken.Apply`, a port of Hex's `spoken_symbols.rs` and
  `spoken_formatting.rs`, English only. Formatting runs first, as in Hex.
* `dictation.spoken_symbols` (off) and `dictation.spoken_formatting` (on).
* The store applies them when it emits a phrase (`Prefs.Spoken`).
* `joinPhrases` (paste), `phraseAtCaret` and `dictatedSlice` (composers) keep a line break.
* Settings: `advancedFields.ts` lists a section's fields behind Advanced; `SectionCard` takes
  `after`, and `AdvancedFold` is the disclosure.

## Decisions

* **Applied once, in the daemon.** Composers and paste both read `DictationService.Session`,
  so one place in the store serves them, the CLI too. The engine's process is left alone,
  so Whisper's prompt tail stays what was really said.
* **Per phrase, not per session.** A phrase has landed by the time the next one is heard,
  so a command only sees its own phrase.
* **"quote … unquote" must fall in one phrase.** Across two phrases both stay as words. The
  word "quote" has already landed when "unquote" arrives and cannot be taken back, and
  holding back every phrase with "quote" in it would stall ordinary text. A pause under the
  engine's 500 ms keeps it one phrase. "open quote" and "close quote" stand alone, so they
  work across phrases.
* **A line break is real text now.** "New line." with a pause around it is a phrase of just
  `\n`, and the old `trim` calls would have dropped it. Both sides now trim spaces only.
* **In a composer it is a paragraph,** what Shift+Enter makes and what the draft serialises to
  `\n`, never a `\n` inside a text node. The textarea takes `\n` as it is. The search dialog's
  field is one line, so there it is a space (`phraseOnOneLine`).
* **The two joins agree.** `phraseAtCaret` now has `joinPhrases`' rule for closing punctuation
  and opening brackets, or "Comma." alone in a phrase would be `Done ,` in a composer and
  `Done,` in a paste.
* **A straight quote at a phrase's edge counts quotes.** An odd count before it means one is
  open, so it hugs the words inside. In a composer that looks at the current line only.
* **The fold is a frontend list,** like `hiddenFields.ts`, so the proto and fixtures stay as
  they are. The search needs nothing: it lists fields as their own rows, open or closed.
* A row in the fold says nothing about dictation being off, as the rows go with it.

## Gotchas

* `_`, `-`, `/`, `#` and `@` join their neighbours inside a phrase only. With a pause at the
  word, "my underscore" then "variable" is `my_ variable`.
* A trailing "new line" is kept: a paste ends with a line break, as asked for.
* The typing path (Chromium 155 and 156) sends `\n` as a character, which the C comment says
  a web page's field takes. It was not tried with one here.

## Verification

`/tmp/cf-check.sh`. Table tests: `TestSpokenSymbols`, `TestSpokenFormatting` (Hex's cases,
its Spanish ones turned into "stays as it is"), `TestSpokenChoice`, `TestSessionPhrasesSpoken`,
`TestJoinPhrases`, `TestDictationFields`, `TestDictationSettingsFromFile`. Vitest:
`dictation.test.ts`, `dictatedSlice.test.ts`, `DictationSettings.test.tsx`, `model.test.ts`,
`hiddenFields.test.ts`. e2e: a line break in the real editor.

**Not run live:** real speech. No microphone was used, so whether Whisper writes "new line" and
"comma" the way these rules expect, and where it splits phrases, is for Alex to try on a tip:
"my underscore variable", "one comma two", "first new line second" with and without a pause,
"quote hello unquote", into a composer and with the hold key into another app.
