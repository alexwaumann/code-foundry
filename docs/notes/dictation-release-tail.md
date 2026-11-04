# Dictation: the release tail (2026-11-04)

People let go of the hold key while the last word is still sounding, and the session stopped
at the release, so that word was clipped. Now a release that counts keeps listening for about
200 ms, and on while speech carries on, up to 600 ms in all. Both destinations (composer by
the hold key, and "system" paste). The mic button, Send and `dictation.stop` keep today's stop.
No setting.

## What shipped

* `internal/dictate/tail.go`: the rules, pure Go. `server.go`: an `end` with `tail` runs one.
* `StopDictationRequest.tail`, `Store.Release`, `conn.Release`; the page's `stopActive(.., tail)`.
* `HEX-LICENSE.md` names the port.

## Decisions

### Where it lives: the engine

Only the engine sees speech window by window. The daemon gets `speech` edges with a 250 ms
onset and a 500 ms close, too slow to judge "100 ms of speech" or "160 ms of quiet", and the
host has only a level. So the engine decides, the store keeps forwarding frames while it does,
and the host changes least of all: it already streams for as long as the snapshot says
LISTENING, and the session stays open through the tail.

The `end` request carries it (`tail`, `tone_ms`) and its reply waits for the session to close,
the one deferred reply in the protocol. Two requests and an event would have put a second
wait in the store for the same answer.

### The tail is held, then handed over

Windows of the tail stay out of the segmenter until its length is known, then the kept ones
go in and it flushes. Hex cuts its clip afterwards; here that is the only way audio that was
heard but not kept never reaches whisper, and it means nothing transcribes during a tail.

### The numbers

Hex's, in Silero's 32 ms windows instead of its 20 ms frames: 3 speech windows (96 ms) for
"still talking", 5 quiet (160 ms) to end a growing tail, 1 quiet (32 ms) stepped over. Speech
uses the segmenter's two thresholds as one bit with hysteresis.

The count starts when the `end` arrives, and the host's frames come in 100 ms bursts, so up
to 100 ms of what follows is from before the release. So the base counts 300 ms (9 windows,
188 to 288 ms past the release), and the most stays 600 ms (18 windows), as a ceiling needs no
allowance. The wall time of a plain tail measured 200 to 330 ms.

### The stop tone

It plays at the release and the microphone is open, so it reaches the engine. The store passes
its length from `dictation.sounds` and the volume (the host does not need to say, and the
composer's page could not). As in Hex, what could be the tone never grows the tail: speech has
to be heard from 300 ms on (100 lag, 140 tone, 60 margin), for 3 windows. If the VAD takes the
tone for speech, the wait runs to that point (416 ms of audio) and the tail stays at the base.
So a tone heard as speech can lengthen the wait by about 130 ms, not the audio kept.
`TestStopToneLength` holds the constant to the WAV.

### Stopping at the release

`session.stopping` is set when Stop arrives, before the tail, so the plate and the pill are
working from the release: measured 1 ms. Frames of a tail raise no level events, as bars still
moving would read as listening.

### A new press during a tail

It cuts the tail, keeps what was heard, and the new hold starts after the flush.

* A second Stop on a stopping session cuts the tail, with or without flush: what was released
  still counts. It now also returns once the session ended, instead of at once, so the Start
  after it finds room. That closes the old race too: a composer press during a system flush
  used to fail "another composer is dictating".
* System after system: the run calls Finish on the last run's session.
* Composer after composer: the page called nothing here at all, because a press on the composer
  already active counted as "keep the session", so a press during a flush was lost. A press on
  a session stopping now starts again.
* **The release chain's second stop would have stopped the new hold's session.** It runs after
  the first stop resolves, by which time a press may own what is open. It now only runs if no
  later press replaced `holdStart`.
* A Start without a Stop is still refused (`ErrBusy`).

### No tail when there is nothing to hear

Stop without flush (a discarded short hold), and a session that never heard a frame. If the
frames stop mid-tail, `TailWait` (700 ms) ends it with what arrived.

## Gotchas

* `TailWait` has to outlast the base by the burst size at least. The daemon's bound on the
  `end` is `FlushWait + TailWait`, and the host's 3 s and the page's 2.5 s still cover it.
* `score()` must return once a tail finishes: closing the session empties `pending`.
* The mic still runs until the session ends, through the flush, as before; the engine drops
  those frames.

## Verification

`/tmp/cf-check.sh`. Go: `TestReleaseTail`, `TestReleaseTailBounds`, `TestReleaseTailKept`,
`TestServer`'s tail rows, `TestTailWaitEndsATailWithNoAudio`, `TestRelease`, `TestTailFrames`,
`TestStopDuringATail`, `TestStartDuringATail`, `TestHoldPressCutsTheTail`, `TestStopToneLength`.
Vitest: `dictation.hold.test.ts`.

Run live, Apple M3 Pro, macOS 27, scratch home:

* **The real engine and model, real tone, stdio, 100 ms bursts in real time.** `say` speech with
  dictate-stop.wav mixed in at the release, at full scale, a quarter and a twentieth. Two
  sentences and four short answers ("Yes", "Okay", "Send it", "Not yet"), released before, at
  and after the end. No tone ever gave any text, and a tone alone after silence gave nothing.
  The one change: "Send it." came back "Send it!" released 150 ms after it, tone full or
  quarter. The tail restores what the old stop clipped, with the tone in it: released 500 ms
  before the end, "...yesterday after" became "...yesterday afternoon.", and "...before the"
  became "...before the meeting.". 600 ms before: "...problems yesterday" and "...finance team
  before" came back whole too.
* **The real daemon, engine and model through `DictationService`,** frames paced as the host's:
  `stopping` 1 ms after the release, 50 to 55 frames kept flowing, the text whole, STOPPED. Today's
  stop on the same audio: as before, 30 frames, dropped. A discarded hold: DISCARDED in 3 ms,
  `stopping` never set. A cut 90 ms in: text kept, the next Start right after the Stop returned.

**Not run, for Alex to try on a tip** (each needs a hand on the keyboard, or the grant):

* A real hold with a real microphone: the tone heard through speakers by a microphone, and its
  latency, which the 60 ms margin is a guess at. Speech here is `say`, fed directly.
* The plate and the pill during a real tail. The daemon's `stopping` timing was measured; their
  reaction to it was not looked at live.
* A press during a tail with real keys, on both routes.
* A slow first press, where the microphone opens late.
