# Dictation 3: the host's microphone (2026-10-29)

PR 3 of five (design: the dictation brief, 2026-10-29). The Wails host becomes the
daemon's microphone. The engine is PR 1 (`dictation-1-engine.md`), the daemon and
`DictationService` PR 2 (`dictation-2-daemon.md`). The composer's mic button comes in
PR 4; until then a session is opened from the CLI (`dictation start`).

## What shipped

* `gui/mic_darwin.go`: AVAudioEngine's input node, tapped at its own format and
  converted to 16 kHz mono int16 by an AVAudioConverter on the tap's thread
  (`downmix = YES`; the input block returns `NoDataNow`, not end of stream, so the
  resampler keeps its state between buffers). Every AVFoundation call runs on one
  goroutine locked to its thread (`avMicrophone`, the terminal actor's `reqs chan
  func()`). Neither callback enters Go: the tap writes samples to a pipe and the
  permission reply writes one byte to another. Each write end is a `dup` the C side owns,
  with `F_SETNOSIGPIPE`.
* `gui/mic.go` (pure Go, tested): `pumpFrames` reads the pipe, cuts it into 20 ms frames
  (640 bytes), computes each frame's RMS (0..1 of full scale) and drops frames when 2 s
  are already waiting. The audio thread never waits on the daemon.
* `gui/dictation.go`: `watchDictation` follows `DictationService.Watch` through the
  host's daemon client (`DaemonService.connect`, which may start the daemon, as for the
  relaunch watcher) and reconnects 2 s after the stream ends. While a snapshot is
  LISTENING with a session id it runs one capture for that session: it checks the
  permission (and asks on the first session, never at launch), opens the microphone and
  streams frames on one `DictationService.Audio` stream. A new session id replaces the
  capture. Leaving LISTENING, or the stream ending, closes the microphone first, then the
  audio stream.
* `gui/responsible_darwin.go`: see below.
* `NSMicrophoneUsageDescription` in `Info.embedded.plist`, `Info.plist` and
  `Info.dev.plist`.

## Decisions

* **Denied ends the session.** PR 2's `MicDenied` only records the flag, so the host
  reports `MicDenied(true)` and then calls `Stop` (no flush) for the session. The
  composer gets `ended` and the snapshot's `mic_denied` for its caption. When the daemon
  already says denied, only `Stop` is sent.
* **Permission changes are reported when seen.** A session with the permission granted
  while the snapshot says denied reports `false`. While idle with `mic_denied` set, every
  snapshot and heartbeat (5 s) rechecks the status (no prompt) and reports `false` once
  the user has allowed it in System Settings, so the caption clears within seconds.
  Nothing at all happens while dictation is off: the watch stream stays open, but no
  permission check, prompt or capture.
* **No microphone** (or an engine that will not start): logged, and the session is
  stopped rather than left listening for 30 s.
* **The host runs as its own responsible process.** macOS attributes a TCC request to
  the process responsible for the requester. For a bare executable started from a
  terminal (`code-foundry gui`, or by hand) that is the terminal app. The first run here
  prompted "Allow "T3 Code (Beta)" to access your microphone?" with T3 Code's own text,
  and the grant would have gone to the terminal. So `main` first starts the executable
  again through `posix_spawn` with `responsibility_spawnattrs_setdisclaim(1)` and exits.
  That is libSystem's private call that LLDB, Chromium and Qt use for the same. It is
  weak-linked and skipped when missing. It only happens when another process is
  responsible (`responsibility_get_pid_responsible_for_pid`) and the executable has its
  own `NSMicrophoneUsageDescription`. That is production builds, which embed
  `Info.embedded.plist`. Dev builds (`wails3 dev`) have none, and TCC kills a process
  that is its own responsible one without a usage string. `CODE_FOUNDRY_GUI_DISCLAIMED`
  guards against a loop and is unset at once, so the daemon does not inherit it. stdio is
  inherited. `--version` exits before this.

## Gotchas

* TCC keys an ad-hoc signed executable by its code signature, so **every rebuilt (or
  updated) GUI asks again**. That held for each build here. A release update will
  prompt once more on the first dictation after it. A Developer ID signature would fix
  that; we have none.
* The prompt from a dev `make gui-build` showed the title only: "Allow "Code Foundry" to
  access your microphone?", with no usage text. That build is linker-signed only
  (`Identifier=a.out`, `Info.plist=not bound`). `scripts/package.sh` re-signs with
  `codesign --sign -`, which binds the embedded plist (`Identifier=dev.alexwaumann.codefoundry`,
  `Info.plist entries=12`). See Verification for what a re-signed copy showed.
* The prompt stays up while the daemon's 30 s silence clock runs, so a first press that
  waits on the prompt longer than that ends silently. The grant still counts for the
  next press. PR 4 may want the composer to say so.
* `installTapOnBus:bufferSize:format:block:` is deprecated in the macOS 27 SDK. Its
  replacement (with an `error:`) is macOS 27 only, and the deployment target is 12, so
  the call sits in a `-Wdeprecated-declarations` pragma. The tap's buffer size must be
  100 to 400 ms. Frames therefore come in bursts of five every 100 ms, and the daemon's
  50 ms level throttle passes about **10 levels a second**, not 20. PR 4's bars should
  ease between levels.
* Speech from the MacBook's speakers into its own microphone measured RMS 0.02–0.045,
  silence about 0.003. PR 4 should map levels on a log (dBFS) scale.
* Not handled: a device change mid-session (AirPods connecting,
  `AVAudioEngineConfigurationChangeNotification`) stops the engine. Frames stop and the
  session ends after 30 s of silence. Opening a Bluetooth headset's microphone switches
  it to its call profile while listening. Both are left for PR 5.
* Audio still in the tap's buffer (≤ 100 ms) when a session stops is not sent: the
  daemon drops frames for a stopping session anyway.

## Verification

`make check` green (two unrelated daemon-start timeouts on the first run under load,
`TestConnectPrefersEndpoint` and `TestDaemonInstallsSkills`, passed alone and on the
rerun). Unit tests: `TestPCMRMS`, `TestFrameChunker`, `TestPumpFrames`, and
`TestDictationWatcher` (eleven table cases over a fake daemon and microphone: off,
idle, stream and close, ask→granted, ask→denied, denied known, granted since, allowed
while idle via heartbeat, no microphone, session replaced, daemon restart). No cgo in
tests.

End to end on an Apple M3 Pro (macOS 27.0), `CODE_FOUNDRY_HOME=/tmp/dict3-home`, the
model copied in, `dictation.enabled` set from the CLI, `make build && make gui-build`, the
built GUI started from a shell. A throwaway Session-stream reader (not committed) opened
the sessions, and `say` spoke through the speakers into the built-in microphone:

* No permission check or prompt at launch. The first session asked: "asking for the
  microphone" in the host log.
* Responsible process: before the fix 41745 → T3 Code; after it the GUI was its own
  (43916 → 43916), and the prompt read "Allow "Code Foundry" to access your microphone?".
* Two `say` sentences, 1.5 s apart, came back as two phrases, word for word: "Let's add
  a retry to the fetch step, then rerun the tests and open a pull request when they
  pass." and "Next, rename the session store to thread store and update every caller."
  Each landed about 1.5 s after `say` returned (VAD's 500 ms of silence, inference, and
  the 100 ms tap). The first Start took 1.5 s because the model had been unloaded (the
  window had been unattended for 10 minutes). Levels: about 10 a second.
* The 30 s silence auto-stop closed the microphone (`microphone closed` at the
  `ended SILENCE`). `dictation stop` (flush) mid-session returned in 0.72 s, and the
  last sentence came back whole before `ended STOPPED`.
* `daemon.restart`: a session opened on the exiting daemon had its microphone closed
  70 ms later when the stream dropped. The host reconnected, and a session on the new
  daemon transcribed ("The demon restarted and dictation still works.").
* `dictation status --json` showed `mic_denied` unset (granted).

Not exercised live: the denied path (a prompt answered Don't Allow, and the heartbeat
recheck after allowing it in System Settings). It is covered by the table test.
