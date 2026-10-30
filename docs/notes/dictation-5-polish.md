# Dictation 5: polish after the first real run (2026-10-29)

PR 5 of five (design: the dictation brief, 2026-10-29). PRs 1-4 built the engine, the
daemon, the host's microphone and the GUI (`dictation-1-engine.md` … `dictation-4-gui.md`).
This one ran the whole chain in the real app for the first time and fixed what that and
the earlier notes left open.

## What shipped

* **Silence counts from the first frame.** A session now waits up to `FirstAudioWait`
  (2 min) for its first audio frame; the 30 s silence clock starts at that frame, and
  again at every end of speech as before. So macOS's microphone prompt no longer eats
  the first session: in the real run the prompt was up 17 s and the session lived on.
  A session that never gets audio (a CLI `dictation start` with no GUI) now ends after
  2 min, not 30 s. Table test: `TestSilenceStop` (11 cases on the fake clock).
* **Hardware changes.** The host observes `AVAudioEngineConfigurationChangeNotification`
  on its engine (a byte down a non-blocking pipe, like the tap; the observer never enters
  Go). The watcher then stops the dead capture and opens a new one for the same session
  and audio stream (3 tries, 300 ms apart). If none opens, it calls Stop so the mic returns
  to idle at once. Frames that end by themselves (capture lost) now stop the session too;
  before, the composer sat listening until the 30 s auto-stop. `TestDictationWatcher`
  gained three cases; `TestPumpSignals`.
* **Level bars.** Levels map on a dBFS scale from -45 (floor) to -15 dBFS. The drawn bars
  ease toward their levels (63% in 60 ms) every frame. The fall-back starts after 250 ms
  without a level (levels come about every 100 ms; 120 ms made them sag between levels).
  Heights are fractional px.
* **The six e2e failures on main** were specs left behind by deliberate changes, so the specs
  changed, not the code:
  * compose.spec.ts:48 and thread.spec.ts:837: the teaching placeholders of 14ab477e7.
  * compose.spec.ts:244 and :288: the Work in detail that no longer names the path.
  * compose.spec.ts:160: 6743f4beb's "focus goes to the prompt after every pick". The spec now
    expects the prompt focused after the base pick, then focuses the base pill and checks that
    Tab reaches Send. That spec, and :291 (which focuses the Work in pill after a pick), first wait for
    the picker's list to close: the picker focuses the prompt again when its exit animation ends, and
    under load that took the keyboard back from the pill (seen failing 2 of 3 full runs).
  * usage-sheet.spec.ts:42: ed01dbc22 raised the sheet's height cap to 1280. The settings spec
    was updated then; the usage spec was not.
* **A flake on main found on the way:** settings.spec.ts:409 failed 4 times in 6 on clean
  main. The sheet ignored every Escape aimed at a keybinding recorder, so after recording
  a chord (focus stays on the recorder) Escape did not close Settings. It passed only when
  the button's brief `disabled` while saving happened to drop focus. Now only a recorder
  that is recording (`data-recording`) keeps Escape; the spec checks the sheet closes.
* **Guide:** one sentence in docs/GETTING-STARTED.md's "Start a thread" (the Guide tab and
  the help skill's copy both come from that file): dictation exists, where to turn it on,
  and the mic and ⇧⌘M. `dictation.*` stays out of the agent guide.
* **Wording:** the setting's description read "⌘⇧M". The keybindings page, the mic's tooltip and
  the guide write "⇧⌘M" (macOS order), so the description now does too.

## The real run (Apple M3 Pro, 36 GB, macOS 27.0)

Dev build (`make build gui-build`, `CODE_FOUNDRY_HOME=/tmp/dict5-home`, the model copied in).
Then the installed release build (`make package VERSION=v0.0.1-dict.5`, `install.sh` from a
local release dir into `/tmp/dict5-release`, `--bin-dir` inside it, `--skip-path`). `say`
played through the speakers into the built-in microphone, at output volume 60. A throwaway
Session-stream reader (not committed) stamped the events.

| Step | Time |
| --- | --- |
| Settings toggle on → Ready (model in the page cache) | 1.5 s (load_ms 894) |
| ⇧⌘M → LISTENING snapshot | 60 ms |
| LISTENING → microphone open (host) | 53-89 ms |
| End of speech → phrase in the composer | 1.02, 1.07, 1.29 s (dev: about 1.2 s twice) |
| Send while listening → flushed phrase + ended | 0.72 s, then the thread started with the text |
| ⇧⌘M in a composer while the CLI held the session → new session | 66 ms |
| First frame → silence auto-stop | 30.1 s (the session had waited 17 s on the prompt) |

* Phrases landed word for word at the caret with smart spacing, the accent tint fading,
  and the marker after the caret.
* Escape stopped the session (STOPPED) and the mic returned to idle.
* Send with flush, the silence auto-stop (no message), and a second composer taking over
  all worked as specified.
* Levels: speech at volume 60 measured RMS 0.07-0.15, the room 0.003-0.012 (it varied with
  fans). On the old -50 dBFS floor, pauses drew about 30% bars; at -45 they draw flat.
* **Not a hallucination fix:** in one session the mic picked up faint real sound (levels
  0.02-0.05 for 4 s; most likely speech from elsewhere in the room). Whisper made "You
  should, I think. Let's eat up the...yourself too again.", then "It's it's it's." and
  "it's". I tried openai/whisper's confidence rule (no-speech probability > 0.6 and mean
  token log probability < -1). With this pinned whisper.cpp and our params,
  `whisper_full_get_segment_no_speech_prob` returned 3.5e-11 for every input (clear speech,
  faint, noise), so the rule can never fire. The log probability alone did not separate
  the cases: clear speech -0.12, speech 26 dB down in noise -0.32, garbled speech 34 dB down
  -0.86. That is not enough data for a threshold, so nothing changed. A follow-up could look
  at why no_speech_prob is constant (`suppress_nst`, `no_timestamps`) before trying again.

## Microphone prompt text

Both the dev build and the installed release build prompted with the title only: "Allow
"Code Foundry" to access your microphone?", with two empty text fields (read through
accessibility). The installed GUI is re-signed by `package.sh`: `Identifier=dev.alexwaumann.codefoundry`,
`Info.plist entries=12`, and the `__info_plist` section holds `NSMicrophoneUsageDescription`.
The process itself reads it, since TCC kills a requester without the key (PR 3 saw that
with dev builds). So the binding is not the problem. Whatever renders the prompt resolves
the purpose string from a bundle on disk and ignores the embedded section. A bare
executable has no such bundle. That is not a packaging fix within the bare-binary layout
(no .app: `bare-binary-distribution.md`). One untested idea: a flat `Info.plist` beside the
executable in `app/`. Testing it costs another prompt answered by hand.

## Not verified

* **Memory pressure:** `sudo -n memory_pressure -S -l warn` needs a password here, so the
  engine's `unloaded` and the reload on the next press are still covered by unit tests
  only. A real pressure run (`memory_pressure` without `-S` allocates until the level is
  reached) would have squeezed the other sessions on this Mac, so it was not tried.
* **Hardware change, live:** no Bluetooth device is paired. Switching the system's default
  input mid-session (to ZoomAudioDevice and back, through CoreAudio) posted no configuration
  change. The running engine stayed on the built-in microphone and the session went on;
  levels did not move. So the reopen path is covered by the watcher's table test with
  fakes only. Whether AirPods connecting posts the notification is still open.

## Gotchas

* cgo cannot size an `id` field in a C struct ("struct size calculation error"). The
  observer is kept as a `void*`.
* Each rebuilt GUI prompts for the microphone again (PR 3). The level change went into the
  release package, so one prompt covered the usage-text check, the bars and the
  screenshots.
* The scratch GUI's default input switch and output volume are system settings. Put them
  back afterwards (here: volume 36, built-in microphone).
