# The microphone crash with a Bluetooth headset (2026-11-04)

A user on v0.21.5-tip.5, with a Bluetooth headset connected to the Mac and a phone, held the
hold key. The microphone cut in and out, the GUI crashed, and it crashed again at every launch
until the daemon restarted.

## What the crash reports showed

Two reports, the same SIGSEGV on macOS 26.7.1, 3 seconds after a "system" session started and
1.7 seconds after the relaunch:

* One thread in `cfMicStop`, in `[AVAudioEngine dealloc]`, down through `~AVAudioIOUnit` to
  `AudioComponentInstanceDispose`.
* Another on AVFoundation's `AVAudioIOUnit` queue, the one that faulted. Go frames sit on top of
  it (`runtime.usleep_trampoline` under `asmcgocall`): that is Go's signal handler running on the
  thread that faulted, not Go code called from audio. Neither the tap nor the observer enters Go.

So the engine was released while its own queue was still working. Nothing catches a SIGSEGV,
so an `@try` would not have helped. The reports do not name the faulting instruction.

## Changes

* **The engine is released 5 s later, off the actor** (`cfMicReleaseLater`), on every path. There
  is no way to wait for AVFoundation's queue, so it gets time instead. `cfMicStop` now stops the
  engine before removing the tap, so the tap's block cannot run during teardown.
* **A hardware change waits for quiet.** After a change the capture waits for 500 ms with no
  further change, at most 2 s, before it touches the microphone. It used to stop at once, in the
  middle of the reconfiguration.
* **A session rides out three changes**, then ends. Opening a microphone can itself change the
  hardware, and there was no limit.
* **A hold left open is ended, not captured.** The first snapshot of a connection with a
  "system" session open means this host lost that hold: it can only start one after seeing a
  snapshot. This was the crash at every launch.
* **The daemon ends a session whose audio stream dies.** A clean close is not an end, as a
  reopened capture may follow; an error is the host going away.

## Not verified

No microphone would start in the process used to build this, and no Bluetooth headset was
available, so the crash was never reproduced and the fix never ran against one. The unit tests
cover the reopen limit, the left-open hold and the lost stream. That 5 s is enough is a judgment.

## Still open

Music paused on the phone. A two-device headset may switch to the Mac for its microphone or for
any sound the Mac plays. AVAudioEngine also binds the default input before `cfMicPin` moves it,
and may use the output side. If that is the cause, moving capture to an input-only AUHAL unit
would leave the headset alone. The start tone is the other candidate.

## The GUI keeps a log now

A launch from Finder or the Dock sends stderr to `/dev/null`, so the host's `dictation:` lines and
a Go crash's goroutine dump were lost, and a report needed a run from a terminal. `keepStderr`
points the descriptor at `<home>/logs/gui.log` unless a terminal is reading it, which catches the
runtime's crash output too. It appends, and starts again past 5 MB. The paste's lines now say why
the text stayed on the clipboard, how long the caret read took, and each paste step. They name
apps and never the text.
