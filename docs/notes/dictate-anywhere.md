# Dictate anywhere: the hold key (2026-11-04)

The PR that finishes "dictate anywhere": hold Option, speak, release, and the text lands.
`dictate-anywhere-settings.md` has the settings and the menu bar item,
`dictate-anywhere-overlay.md` the plate, `accessibility-probe.md` what the probe was for.

## What shipped

* `gui/althold.go`: the hold rules, pure Go. `gui/althold_darwin.go`: the tap.
* `gui/hold.go`: the service: listener lifecycle, routing, a run per hold, delivery. Pure
  Go behind `holdOS`. `gui/hold_darwin.go`: `holdOS` on macOS, and the Allow prompt.
* `gui/paste.go`, `gui/paste_darwin.go`: the decision, joining, the clipboard race, typing.
* `gui/hostintents.go`: the host follows `UiService.WatchIntents` for `dictation.allow`.
* `gui/singleinstance.go`: one GUI per home.
* Daemon: `DictationService.Accessibility`, `ComposerTarget`, snapshot fields `sound_volume`,
  `composer_target`, `accessibility`; commands `dictation.hold` and `dictation.allow`.
* Settings › General › Dictation: `DictationAccessRow`.
* The probe is gone, with `responsiblePid` and the `spawnDisclaimed` split.

## Decisions

### The hold

* **On press, the session starts and the mic opens.** A hold under 300 ms is a Stop without
  flush, so it ends DISCARDED. Hex's rule stopped at the release, so the 300 ms is only
  judged then; there is no timer in the machine.
* **Modifiers cancel only before 300 ms; a key at any time.** With `left` or `right` the
  other Option is a modifier like any other. With `both` (either key works) it is
  nothing at any time, and the hold runs from the first key down to the last key up.
* **A press with a modifier already down is a chord**, and starts nothing. It must end
  before another can start, so Option left down after Control comes up stays nothing.
* **Why never names a key.** `altReport.Why` reaches a log, and logs of what was pressed
  are a keylogger's. No log has dictated text either: `pasteText`'s steps lost the text.
* **The listener never exists without the grant.** That is the only way to be sure creating
  it cannot prompt, and it means no tap is ever made before a grant.

### Off the tap's thread

The callback only writes to a pipe. The service's one loop reads events and hands out work:
a press becomes a goroutine that reads the front app (a hop to the main thread), routes, and
talks to the daemon; texts go to a paste goroutine. `TestHoldNeverBlocksTheEvents` holds
each of those up and checks the loop still takes events. The paste does not run on the main
thread either, as reading the pasteboard can wait on an owner rendering promised data; only
`frontmost` does, per the probe's gotcha. The tap's thread got the health timer and App Nap
opt-out the probe's gotchas asked for. Its run loop had a race too: `CFRunLoopStop` before
the loop was entered was lost and `Stop` hung, so it now checks a flag on a 1 s timeout.

### Routing: how the host starts a composer's session

Two things had to cross from the page to the host and back, through the daemon only.

* **Is there a composer?** The host must know at the press, with no round trip, because
  "no composer" means a different destination. The page tells the daemon when the answer
  changes (`DictationService.ComposerTarget`, a report like MicDenied), and the host reads
  `composer_target` from the snapshot it already follows. `pickTarget` is `dictation.toggle`'s
  choice, shared. It reports only while dictation is on, and corrects the daemon whenever
  a snapshot disagrees, which covers a daemon restart.
* **Start and stop.** The host runs `dictation.hold --phase press|release|discard`, which
  is a ShowView intent. The page calls the `startFor` and `stopActive` it already has, so
  every phase (starting, listening, stopping) stays in one state machine: `presentDictationHold`
  is a dozen lines. The host never learns the session id. The one new rule: a stop waits
  for a press still getting its session, or the mic it opens would stay open.

With several windows `composer_target` is last writer wins. There is one in production; only
a browser dev frontend beside the GUI can confuse it. A page that crashes leaves the flag
true until it reloads; a press then does nothing.

A window with no composer counts as any other app, as the brief's "anything else" says: the
text pastes into what has the keyboard there, and the overlay shows.

### Paste

* Decided when the text is ready, not at the release, since the flush takes about 0.6 s.
* **The grant is part of the decision.** With it gone macOS drops Cmd+V without a word and
  the old clipboard would come back, losing the text. It goes to the clipboard instead, as
  does anything that fails.
* `pressed.PID == 0` (nothing in front) also goes to the clipboard.
* A session that ended by itself mid-hold (30 s of silence) still pastes what it heard.
* **Chromium 155 and 156: ported, and it stayed small** (25 lines of Go, 40 of C). No
  case or spacing changes: `joinPhrases` trims, joins with a space, and leaves the
  engine's capitalisation, as `phraseAtCaret` does.
* A press during another's flush waits for it, or the daemon would refuse the Start. It does
  not wait for the paste. A press during a tail cuts the tail first
  (`dictation-release-tail.md`).
* A session someone else holds gives way, as it does to a composer: flushed to its client.

### Sounds

The start tone is `time.AfterFunc` after 40 ms and checks whether the keeper has decided
the hold's end; so a tap of Option over 40 ms is audible, as the brief says. The microphone
stays open through the stop tone now: `dictation-release-tail.md` has why it does no harm.

**The tones do not end up as text.** Fed through the real engine and model at full scale,
a quarter and a twentieth, alone, before speech, after speech and both together, no tone
gave any text, and speech beside them came back word for word. Full scale fed directly is far
louder than a speaker heard by a microphone. So there is no mute after the press.

### The grant and the row

* The host polls `AXIsProcessTrusted` once a second while dictation is on and it is not
  granted, and every 5 s once all is well, to notice a revoked grant. Nothing at all with
  dictation off. The 1 Hz also covers a new tap that has heard nothing yet.
* The report carries the list's name (`isOperatingSystemAtLeastVersion`) and the
  executable's path, so the page needs no OS knowledge. A row needs a report, so a browser
  shows none.
* **`dictation.allow` reaches the host on `UiService.WatchIntents`,** not through a Wails
  binding, as the page talks only to the daemon. `Windows()` counts event streams, so this
  stream is not counted as a window. It works with the window hidden.
* The advice to remove and re-add shows 30 s after Allow, timed in the page. Allow stays
  there, as its prompt is what adds the fresh entry.
* The URL is Hex's. Read on this Mac, not opened: `allowsXAppleSystemPreferencesURLScheme`
  in `SecurityPrivacyExtension.appex`, whose binary still has `Privacy_Accessibility` on
  macOS 27.

### After the grant: which of the two shipped

**Both are in, and the in-process rebuild is the first thing tried.** Nothing on this Mac can
say which one users will end up on.

What is known: a tap made before a grant stays silent (a real run). Here no tap is made
before a grant, which already avoids the case that was seen. Hex recreates a missing tap on
a timer and has no restart path for Accessibility; an Apple forum post reports a tap failing
before the grant and working after it. Neither is a process that flipped on macOS 27 with a
bare executable, and finding out needs an answered grant.

So when trust flips, any tap goes and a new one is made, and a `tapWatch` checks it. A tap
cannot say it is deaf (`CGEventTapIsEnabled` says yes), so the evidence is the login
session's own counter, `CGEventSourceSecondsSinceLastEventType`, which needs no grant. Keys
seen there in three checks with the tap having heard nothing, none under secure input,
make `tap_silent`, and the row offers Restart (`app.restart`). One event from the tap
clears it. A refused `CGEventTapCreate` while trusted reads the same. A wrong guess costs a
button, as it can only appear on a tap that has heard nothing at all.

The combined session state, not the HID one: on this Mac the HID counter for keys read 23
hours while combined read 7 minutes, and combined is what a session tap sees.

### One GUI per home

Wails's `SingleInstance` fits: a flock in `NSTemporaryDirectory` and a distributed
notification, both named by `UniqueID`, which is a hash of the resolved home. It applies with
the settings off too: the lock is taken in `application.New`, before any setting can be read,
and there is no use for two windows on one home. `Relaunch` waits for the old process, so
it never meets the lock. A second launch ends inside New, before any watcher starts.

### Menu bar

The item and close-to-menu-bar follow `enabled && anywhere`, in one place: what the watcher
passes on. This replaces `dictate-anywhere-settings.md`'s "whether or not `dictation.enabled`
is on". The overlay's panel prepares on the same value.

## Gotchas

* `CGEventSourceFlagsState` could catch a lost release mid-hold. Left out: whether its bits
  hold up under secure input could not be checked without pressing keys. A lost release heals
  at the next flags event, and the 30 s silence stop closes the mic meanwhile.
* The V key is still `kVK_ANSI_V`, a position: wrong on Dvorak and similar layouts (Cmd+K
  there). Open. The typing path has no such problem.
* The fixed identity is forgeable (`tcc-read-errors.md`). With this grant on it, any local
  program signed with that identifier could post events and read keys. The probe's note asked
  for this to be weighed before shipping; it is still a decision to make.
* The tail counts from the Stop, so it covers the 100 ms buffer in flight at the release
  (`dictation-3-host.md`, `dictation-release-tail.md`).
* Press before a mic permission: the first hold asks. The prompt outlasts the hold.

## Verification

`/tmp/cf-check.sh`. Table tests: `TestAltHold` and `TestAltHoldSetMode`, `TestRouteHold`,
`TestDictationUsable`, `TestDecidePaste`, `TestJoinPhrases`, `TestHasClipboardRace`, `TestTapWatch`,
`TestHoldRuns`, `TestHoldToneCancelled`, `TestHoldLandFallsBackToTheClipboard`,
`TestHoldNeverBlocksTheEvents`, `TestHoldWaitsForTheLastFlush`, `TestHoldListener`,
`TestHostIntentWatcher`, `TestSingleInstanceID`. Vitest: `DictationSettings.test.tsx`,
`dictation.hold.test.ts`. No cgo in tests.

Run live, Apple M3 Pro, macOS 27, scratch homes, nothing granted:

* Built GUI: Accessibility reported false with the right list name and path, no tap, no
  prompt. Second launch with the window showing and with it hidden: exit 0, one process,
  window back in front, Foreground. A second home: two processes. Dictation off while
  hidden: window back. Anywhere on with dictation off: red button quits, lock file gone.
* `holdService` on the real daemon, engine and model, with a fake tap and a fake macOS, no
  host attached: Start 6.5 ms after the press, flush 0.64 s, the text whole, a short hold
  ended DISCARDED, `dictation.allow` arrived on `WatchIntents`, a bad phase refused.
* The real page in WebKit on a real dev daemon: `composer_target` true on the home composer
  and false on the Pull Requests page; `dictation.hold` opened a session under the
  composer's client id, release and discard ended it, a press with no composer did nothing.
* The tones through the engine, above. The idle counters read in an ungranted process: no
  prompt, real values.

**Not run, because each needs the grant or a hand on the keyboard:**

* A real tap in this build: the C changes (health timer, App Nap, the stop flag) have only
  been compiled. The run loop is the risky one.
* Real Option presses: a hold of each mode, Option+arrow still reaching
  the app.
* Whether the rebuilt tap hears anything after a grant in the same process, or the Restart
  row appears instead.
* `AXIsProcessTrustedWithOptions` and the pane opening; the entry the prompt adds; a revoked
  grant.
* Real Cmd+V, real typing and the real clipboard (`cfPasteCopy`, `cfPasteType`): the general
  pasteboard was not touched here.
* A real microphone with a hold, the tones through real speakers, the plate during a hold.
* A real Chromium 155/156 app.

## Hold key options (follow-up)

`dictation.hold_key` is `left`, `right` or `both`, and `both` means either key works. The first
version also had `either` and a `both` that needed the two keys together, from a misread
request. A saved `either` is now an unknown value: it falls back to the default, which means
the same, and the file keeps it under an "Ignored" comment. A saved `both` changes meaning
from together to either. Only tip releases ever had those options, so no migration.
