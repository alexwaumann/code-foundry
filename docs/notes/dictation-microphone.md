# Dictation: Microphone and Avoid Bluetooth (2026-11-04)

PR 3 of three, on `dictation-other-audio.md`'s. `dictation.microphone` (a device UID, "" for
System default) and `dictation.avoid_bluetooth` (on), so a headset is not pushed into call audio.

**Pinning an input was not run on real audio.** See below: try it before merging.

## What shipped

* `internal/dictate/microphone.go`: `PickMicrophone`, the rules, pure Go, from Hex's `audio.rs`.
* `gui/inputs.go`, `gui/inputs_darwin.go`: the list, the report, the listener, the lid.
* `gui/mic_darwin.go`: `cfMicPin` sets `kAudioOutputUnitProperty_CurrentDevice` on the input
  node's audio unit, before its format is read. `openMic` in `gui/dictation.go` chooses.
* `DictationService.Inputs`; snapshot fields `microphone`, `avoid_bluetooth`, `inputs` and
  `microphone_pick`. Row: `DictationMicrophoneEditor`, and `keyDescriptions` for a description
  that replaces the setting's own.

## Decisions

* **One set of rules, two callers.** The host runs `PickMicrophone` on a fresh list at every open.
  The daemon runs it to fill `microphone_pick` for the row, so the page holds no rules and a
  changed setting shows with no round trip through the host.
* **System default is left alone.** No pin unless a stand-in or a named microphone is chosen, so
  that path is the capture that has always run, reopen included.
* **An input that will not open gives way to the system default,** with a warning in the log:
  the wrong microphone beats no session.
* **Reported like Accessibility:** only while dictation is on, whenever the snapshot disagrees,
  so a restarted daemon is told again. A CoreAudio listener on the devices and default input
  makes it immediate. A 5 s recheck catches the lid, which has no listener here.
* **The mic still opens on press and closes when idle.** Listing opens nothing.
* **A named mic that is away keeps its name.** A device that is gone is not listed, so the host
  keeps the last name per UID in `input-names.json`. It stays in the menu, marked Not connected.
  A UID never seen (a hand edit) reads "That microphone".
* **"is" or "are"** goes by the word: pods, buds, phones and beats are plural (`deviceVerb`).
* **A named built-in mic with the lid closed** reads as missing, as Hex treats it. "isn't
  connected" is a little off for a lid; the sketches have no line for it.
* **Missing, with a Bluetooth default and avoid on:** the stand-in rule still applies, as in Hex.
* A setting changed during a session applies at the next open, which Hex calls "once idle".

## Gotchas

* **`[engine inputNode]` binds the system default before the pin moves it.** With AirPods as
  the default, that first bind might wake their microphone and start call audio, which would
  defeat the setting. It only creates an IOProc and starts no I/O, so it should not. Unchecked.
* A pinned engine may not get `AVAudioEngineConfigurationChangeNotification` when its device is
  pulled. If not, frames stop and the session ends after 30 s of silence, with no reopen.
* Virtual inputs are listed, as someone may want one, but never stand in.

## Verification

`/tmp/cf-check.sh`. Table tests: `TestPickMicrophone`, `TestInputTransport`, `TestInputNames`,
`TestInputReporter`, `TestDictationOpensTheChosenInput`, `TestDictationSnapshotPick`,
`TestHostReports`, `TestDictationFields`, `TestDictationSettingsFromFile`. Vitest:
`DictationSettings.test.tsx`, `dictation.test.ts`, `hiddenFields.test.ts`. No cgo in tests.

Run live, Apple M3 Pro, macOS 27, scratch home, built GUI, no session started:

* `listInputs` on the real Mac: MacBook Pro Microphone `built_in`, ZoomAudioDevice `virtual`, the
  right default, the lid open. It needed no permission and opened nothing.
* The GUI reported them. `dictation status` showed `named` for the built-in UID and `missing`
  for a UID that does not exist.
* From PR 2, on the real GUI: a volume left low by `kill -9` was put back at launch. SIGTERM
  quit cleanly. In a test binary, `close` with the volume low put it back at once.

**The pin could not be verified.** Every input failed to start from a process launched here, not
just a pinned one: `[engine inputNode]` with no pin, and a plain AUHAL set straight to the idle
Zoom device, both hung in `HALC_ProxyIOContext::_TellServerAboutStreamUsage`. `tccd` had answered
allowed, so it was no prompt. The cause was not found; Hex holding the built-in mic was seen at
the time, but the idle device hung too. The built GUI was not used instead, as a fresh build
would have asked for the microphone. So nothing here shows pinning works or fails.

**Not run live, for Alex on a tip, in this order:**

1. A named microphone: does the tap get audio, and does the converter take its format?
2. AirPods as the default with Avoid on: is it the Mac's mic, and does music stay in high quality?
3. Avoid off, and a named Bluetooth mic: the headset's mic is used.
4. Unplug a named USB mic during a session; start one with it away; plug it back and press again.
5. AirPods connecting during a session, pinned and not: does the reopen work?
6. Lid closed with an external display.
7. The row updating by itself on a real connect (the listener was started, never fired here).
