# Dictation: smart spacing and continuing dictation (2026-11-04)

Text pasted into other apps now fits the caret. Before pasting, the host reads the character
before the caret through Accessibility and adds one leading space when it belongs. A dictation
right after the last one, with nothing touched between, joins it with sentence-aware spacing
and case: "Because if I don't do that," then "And if you see it." pastes " and if you see it.".
Always on, no setting. Composers have their own spacing, and never reach this code.

## What shipped

* `gui/paste.go`: `smartSpaced`, `needsLeadingSpace`, `joinContinuation`, `endsSentence`,
  `setInitialCase`, all pure. Ported from Hex's `src_paste.rs`; `HEX-LICENSE.md` names them.
* `gui/paste_darwin.go`: `cfCharBeforeCaret`, from Hex's `char_before_caret`.
* `gui/hold.go`: `land` fits the text (`fitCaret`); `continuation`, `countsAsInput`.
* `gui/althold_darwin.go`: the tap also hears mouse-down, still listen-only.

## Decisions

### Which rule runs

Continuation first, as in Hex: it knows the text, so no read is needed. Otherwise the read.
Both change only what is about to be typed or pasted. Text left on the clipboard is not spaced,
as it may be pasted anywhere, and a failed paste leaves the text without the space, for the same
reason.

### What ends a continuation

`inputs` is a counter, read before the paste and compared at the next one.

* **It counts** a key, a mouse button, and anything that means events went by unseen: records
  dropped from the pipe, a disabled tap, the tap ending. A wrong "ended" costs a space read; a
  wrong "continued" lowers a capital in the wrong place.
* **It does not count** flags events, so the hold key's own presses never do. A modifier alone
  (Shift tapped) does not either, as in Hex: it moves no caret.
* Our own Cmd+V and typed events carry `CF_PASTE_MARK` and the tap drops them already.
* The frontmost app is compared at each landing, by pid.
* Text left on the clipboard, or a failed paste, ends it too: nothing landed for the next one to
  follow. A dictation with nothing said leaves it alone.

### A click is not "the tap hears"

`tapWatch` reads any event as proof the tap works, and the Restart row depends on that. macOS
guards keys more closely than the mouse, so a tap deaf to keys may still hear clicks, and one
click would then clear its row for good. That was not measured; leaving clicks out costs nothing
(`TestHoldClickIsNotHearingKeys`).

### Differences from Hex

* Closing and opening punctuation are one list, shared with `spaceBetween`, so `…`, `”`, `’` and
  `»` count as closing before text too. Hex's `is_closing` has the ASCII ones only.
* `endsSentence` looks past curly quotes and `»` as well.
* Hex has no frontmost check on a continuation; the brief asked for one.

### Off the tap's thread

The read runs in `land`, on the paste goroutine, which is neither the tap's thread nor the main
thread. Each Accessibility call has a 0.25 s messaging timeout and the first one to fail ends
the read, so a hung app costs about that and the paste goes ahead unspaced. Nothing is logged:
not the character, not whether one came back.

## Gotchas

* **An app that is not active has no focused element** (`kAXErrorNoValue`). This only ever reads
  the app in front, but a test against a background window reads nothing.
* An app that goes away and comes back with no key or click (a dialog taking focus by itself) is
  invisible to the pid check, which only looks at landings.
* Keys under secure input are hidden from the tap. Text landing then goes to the clipboard, which
  ends a continuation, but keys typed in a password field between two dictations in the same app
  would not. Getting there and back takes a click or Tab, which do count.
* Straight quotes get no space after them: `"` could open or close.

## Verification

`/tmp/cf-check.sh`. Table tests, pure Go: `TestNeedsLeadingSpace`, `TestSmartSpaced`,
`TestJoinContinuation`, `TestEndsSentence`, `TestSetInitialCase`, `TestSentenceInitialWord`,
`TestCountsAsInput`, `TestHoldLandFitsTheCaret` (each way a continuation ends or survives),
`TestHoldClickIsNotHearingKeys`, `TestAltHold`'s click row, and the slow-app case of
`TestHoldNeverBlocksTheEvents`.

Run live, Apple M3 Pro, macOS 27. The shell here already held a grant, and nothing was granted or
prompted. `cfCharBeforeCaret`, its C copied unchanged out of `paste_darwin.go`, against a throwaway
off-screen `NSTextView`:

* The focused-element call replaced by a walk of `AXWindows`, as the window was not active and
  activating it would take focus from whoever is at the Mac. Everything after that call ran:
  letter, space, `@`, `”`, and an emoji whose surrogate pair came back as U+1F600, 20 to 40 ms each.
  At the start, in an empty field and with a selection it said nothing.
* Unchanged: a hung app (main thread asleep) returned in 295 ms; no such pid in 11 ms.

`make gui-build` compiles the tap and the read.

**Not run, for Alex to try on a tip:**

* A real tap in this build: mouse-down reaching the service, and a click not cancelling a hold.
  Creating a tap here could have raised the Input Monitoring prompt.
* `AXFocusedUIElement` on a real frontmost app, so the read's first step.
* A real paste with the space or the join, in any app. The general pasteboard was not touched.
* What real apps say. Worth trying: Notes and TextEdit (should read), Terminal, a browser field,
  Electron and Chromium apps, where the read may give nothing and the text lands unchanged.
