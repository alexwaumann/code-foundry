# Dictation: capture through AUHAL (2026-11-04)

`gui/mic_darwin.go` no longer uses AVAudioEngine. Capture is an input-only AUHAL unit. This
follows `dictation-mic-crash.md` and answers its "Still open" section.

**It has never captured audio from the shipped code.** See "Not verified": try it before merging.

## Why

A throwaway probe (`scripts/mic-probe.m` on `cf/mic-probe`) ran on a user's Mac, macOS 26.7.1,
5 seconds a mode. `plain` is AVAudioEngine on the system default, `pin` is
`kAudioOutputUnitProperty_CurrentDevice` set on the engine's input unit, and `auhal` is an
input-only HAL unit on the built-in mic.

| Setup | Mode | Result |
| --- | --- | --- |
| No headset | `plain` | 0 configuration changes |
| No headset | `pin` | 1 change |
| No headset | `auhal` | 240128 frames, audio present |
| WH-1000XM5, default in and out, also on a phone | `plain` | 16 kHz, 1 change, 76800 frames, paused the phone's music |
| Same | `pin` | 2 changes, engine stopped, 0 frames, paused the music |
| Same | `auhal` | about 239600 frames, audio present, did not pause the music |

So three problems had one cause:

* The pin made dictation loop and die. Each change made us reopen and pin again, until the
  3-change limit ended the session.
* AVAudioEngine is what took the headset.
* Releasing an engine mid-reconfiguration was the SIGSEGV of #544.

## What shipped

* **The unit.** `kAudioUnitSubType_HALOutput`, input on element 1, output off on element 0, and
  the device always set explicitly. With no UID that is the default input as it is at open. The
  client format is Float32 mono at the device's rate, as an input unit does no rate conversion.
* **The IO thread.** `cfMicInput` only renders into preallocated memory and copies into a
  single-producer single-consumer ring (`gui/mic_ring_darwin.h`, C11 atomics). A full ring drops
  the block and counts it. The ring's and scratch memory are written at setup, so the IO thread
  takes no page fault.
* **The drain.** A 20 ms timer on a serial queue empties the ring through AVAudioConverter and
  writes the pipe. Neither side enters Go.
* **The watch.** `AudioObjectAddPropertyListenerBlock` on a private serial queue, for
  `kAudioDevicePropertyDeviceIsAlive` and `kAudioDevicePropertyNominalSampleRate` on the device,
  and `kAudioHardwarePropertyDefaultInputDevice` only when following the default. Each writes a
  byte to the change pipe, so `gui/dictation.go`'s 500 ms settle and 3-change limit are unchanged.
* **Teardown.** `cfMicClose`, for stop and every failed start: remove listeners and flush their
  queue, stop, uninitialize, cancel the timer and `dispatch_sync` the drain, close the sinks,
  dispose, free. `cfMicReleaseLater` went with the engine.
* **A log line.** `dictation: capture closed` gives the rate, frames, dropped samples, render
  errors and convert errors. This is the only Go change of substance, and `newAVMicrophone` takes
  a logger for it. With no way to run this here, it is how a real run gets read.

## Decisions

* **A notification is not a change.** The watch re-reads the hardware and writes a byte only if
  it differs from what was opened: device gone, rate changed, default moved. A repeated
  notification on a settled device would otherwise spend the reopen limit.
* **Listeners go on before the start,** so one that fails never wakes a headset. The same check
  runs once after the start, to catch what moved before the listeners were on.
* **The watch block holds no pointer to the capture.** CoreAudio may still have one queued as the
  listener goes. It captures values and a retained sink, which reads closed by then.
* **MRC stays.** The file uses it, and the retained sink in the block needs nothing else.
* **The ring lives in a header** so its real code can be compiled alone. `.h` files carry the
  same `_darwin` build constraint as Go files.
* **The ring is a fixed 1 MiB,** 5 s at 48 kHz. Capacity adds no latency, as the drain empties
  what is there, so there is no reason to compute it from the rate.

## Gotchas

* **The converter can keep reading its input after it returns.** If `out` fills first it has not
  finished with `in`. An early version refilled `in` then, and after a stall (a large chunk) that
  gave clicks and lost samples at 96 kHz. `cfMicDrain` now calls the converter until it asks for
  more and hears `NoDataNow`, so `in` is free.
* **A large chunk sits in the converter as latency.** With 8192 frames at 8 kHz, 4096 output
  samples (250 ms) stayed behind; at 20 ms chunks only a few do. That loses nothing, but it is why
  `cfMicChunkFrames` is 2048.
* **Mono now means the device's first channel.** The engine path downmixed with `downmix = YES`;
  the client format now asks the unit for one channel. A multi-channel input whose mic is not on
  channel 1 would be silent. Not seen; worth knowing if a USB interface reports no audio.
* **Levels come about every 20 ms,** not in bursts of five every 100 ms, so up to 20 levels a
  second get through the daemon's 50 ms throttle. `dictation-5-polish.md`'s 250 ms fall-back still
  holds; the bars may look livelier.
* The gotcha in `dictation-microphone.md` about a pinned engine not hearing its device being
  pulled should be gone, as `kAudioDevicePropertyDeviceIsAlive` is on the device itself. Unchecked.

## Verification

`/tmp/cf-check.sh` and `make gui-build`. On this Mac no audio can start: every process stalls in
`HALC_ProxyIOContext::_TellServerAboutStreamUsage`. For AUHAL that is under an
`AudioUnitSetProperty` that creates the IOProc, seen with `sample` on a process killed after 6 s.
The stack does not say which property, but it comes before `AudioUnitInitialize`, which was never
reached. So the checks stopped short of the device. Run as throwaway
programs outside the repo, on the shipped source (the ring header, and `mic_darwin.go`'s preamble
extracted), not on a copy:

* **The ring.** Fixed cases (empty, too large, does not fit, wrap, exactly full), then 40 million
  samples through two threads, checked for order and loss, plain and under TSan and ASan/UBSan.
* **The drain.** A thread played the IO thread: a 1 kHz sine at 8, 16, 24, 44.1, 48 and 96 kHz in
  blocks of 128, 512 and 4096, through the real ring, timer, converter and pipe, at 8x and at real
  time for 16, 44.1 and 48 kHz, and with the queue suspended to force a backlog. Output checked
  for length, level, phase jumps (a lost sample is a jump) and clicks. Plain and under ASan.
* **Converter chunking.** 9 rates to 192 kHz, 5 chunk patterns including 20 ms with 40% jitter.
* **Teardown of the drain.** 50 open and close rounds with the pipe's reader already gone.
* **The watch, on real device objects.** `cfMicMoved` on the default, on the Mac's other devices
  (following: moved; pinned: not moved), with a wrong rate and with a dead id. Then 80 rounds of
  adding and removing the listeners, under ASan, including the block called after the close: it
  found the sink closed and every write end was gone.
* **A bad UID** through the real `cfMicStart` fails with "that input is not connected".

Go tests are untouched and cover the reopen limit, settle and fallback. No cgo in tests.

## Not verified

Everything from the unit's setup on has never run to completion in the shipped form:

* `cfMicOpen` past the device lookup, `cfMicInput`, and `AudioUnitRender` into our buffer. The
  probe did these on a user's Mac, but it was not this code.
* `cfMicClose` with a live unit, and on a start that fails partway.
* A listener firing for real. They were added and removed, never triggered.
* That the device's nominal rate never differs from the unit's format at open, or moves by itself
  while we run. A device that did would show as a change at every open and end the session at the
  limit.

**For a real run, in this order.** The log line gives the frames and drops; expect dropped and
errors at 0.

1. Built-in mic, no headset: the words come back, and frames are about the rate times the seconds.
2. WH-1000XM5 (or similar) default in and out, also on a phone, Avoid Bluetooth on: built-in mic,
   no "the audio hardware changed" line in the log, the phone's music plays on.
3. Same, Avoid off: the headset's mic is used. If its rate moves as it changes mode, expect one
   reopen. If stopping lets it switch back and each open flips it again, it stops at the
   3-change limit: the reopen path would then need another look.
4. Unplug a named USB mic during a session: one reopen, and the fallback.
5. System default, then change the default input during a session: one reopen on the new input.
6. Hold and release many times quickly, with and without a headset: no crash, no stuck session.
