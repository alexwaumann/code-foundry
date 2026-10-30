# Dictation 2: the daemon (2026-10-29)

PR 2 of five (design: the dictation brief, 2026-10-29). Adds `DictationService`, the
dictation store (`internal/store/dictation`), the `dictation.enabled` setting and the
`dictation.*` commands. The engine (`code-foundry-dictate`) is PR 1
(`dictation-1-engine.md`); the host's microphone is PR 3 and the GUI PR 4. Nothing in
the GUI uses this yet, except the generic settings page, which shows the new toggle.

## What shipped

* `proto/codefoundry/v1/dictation.proto`: `DictationService` with Watch, Download,
  CancelDownload, RemoveModel, Start, Stop, Session, Audio (client stream), MicDenied, as
  the brief specifies. The client also gets `client.Client.Dictation` for the host.
* Settings: group `dictation`, `dictation.enabled` (Bool, default off), General ›
  Dictation between Lifecycle and Updates, with the brief's section description.
  `Settings.Dictation.Enabled`. Applies live (`internal/daemon/settings.go`).
* `internal/store/dictation`: the model registry (one entry), the downloader, hardware
  facts, the engine protocol client (`EngineConn` over `childproc`), the supervisor and
  sessions. `dictationtest` has a fake engine (scripted phrases, crashes, a load gate), a
  launcher and a fake clock.
* `internal/api/dictation.go`, wired in `internal/daemon/dictation.go`.
* Commands: `dictation.toggle` (⌘⇧M, "Dictate"), `dictation.start`, `dictation.stop`,
  `dictation.download`, `dictation.download.cancel`, `dictation.remove` (confirms),
  `dictation.status` (`--json` prints the snapshot).

## The model

`ggml-large-v3-turbo-q8_0.bin`, 874,188,075 bytes, sha256
`317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1`. That is the Git LFS
oid of the file (`/raw/main/` serves the pointer; `x-linked-etag` on `/resolve/` says the
same). Checked on 2026-10-29 by downloading the file with curl and hashing it, and again
by the store's own download in the end-to-end run. PR 1 pinned the same values.

The same file is mirrored as a pre-release asset on the release repository and downloaded
from there through gh first, Hugging Face second (docs/notes/dictation-6-model-mirror.md).

Stored at `<home>/dictation/models/` (`paths.DictationModels`). At start the store counts
the model as present when a file of the pinned size is there: hashing 874 MB on every
start is too slow, and the download verified it once.

## Decisions

* **Engine path**: `$CODE_FOUNDRY_DICTATE_BIN`, else `code-foundry-dictate` beside the
  running executable (`update.RunningDir()`, symlinks resolved, so
  `~/.local/bin/code-foundry` finds the install). A missing executable is a permanent
  failure: the state is ERROR at once, with no restarts.
* **A finished download turns dictation on.** The store calls `Options.Enable`, which
  sets `dictation.enabled = true` through the settings store; its OnChange then starts
  the engine. That gives the sketch's "Downloading. Dictation turns on when it finishes"
  without the GUI holding state. It holds for the CLI's `dictation.download` too, and the
  command says so.
* **Cancel keeps the `.part`** so the next Download resumes it with a byte range.
  RemoveModel deletes the model and the `.part`. A sha256 mismatch deletes the `.part`
  (the next download starts over). A server that ignores the range (200) or a part longer
  than the model also starts over. 416 truncates the part and fails the attempt.
* **Away stops the engine** instead of calling `unload`. PR 1 measured about 170 MB left
  resident after `unload` (ggml and Metal residue), and the brief allows the process to
  exit. Back (attended), or a Start, starts it and loads the model (about 4.6 s on an M3
  Pro). The engine's own `unloaded` (memory pressure) keeps the process up and the state
  UNLOADED, and the model loads again only on the next Start. An open session holds the
  away unload until it ends.
* **States**: DOWNLOADING wins over everything (a download can run while dictation is
  off). LOADING covers the engine starting, the model loading and the wait before a
  restart. ERROR clears on off and on, and on RemoveModel.
* **Restarts**: 1 s, 4 s, 15 s, then ERROR on the fourth failure in a row. A successful
  load resets the count, so a crash after loading is "the first failure" again.
* **Auto-stop**: the 30 s window starts when the session starts or on `speech
  {active:false}`. `speech {active:true}` stops the clock. So a speaker who talks for
  40 s without a pause is not cut off; "30 s without speech" means 30 s of silence. Stop
  for silence does not flush (there is nothing pending).
* **Stop with flush waits for the phrases.** The engine sends a flushed phrase before
  `end`'s reply, but the store's event goroutine may not have handled it yet when the
  reply arrives. `Engine.Enqueued()` counts events received. After the reply Stop waits
  (inside the same 1.5 s bound) until the watcher has handled that many, so the phrase is
  published before `ended`.
* **One session at a time.** Start by another client is Aborted ("another composer is
  dictating; stop it first"). The same client starting again gets its open session back,
  for a double press. Start while unloaded waits for the load (bounded at 2 min and by the
  request), and the snapshot shows LOADING meanwhile.
* **Levels**: the frame's `rms` from the host is republished at most every 50 ms; the
  others are dropped. Frames for a session that is not listening, or one that is
  stopping, are dropped.
* **Session stream** opens with a heartbeat, because a Connect client's call returns only
  once it has headers. It sends a heartbeat after 5 s of silence (like the other GUI
  streams), and ends after `ended`. A late subscriber to an ended session gets `ended` at
  once (the last 32 ended sessions are remembered); an unknown id is NotFound.
* **Naming**: the RPC names and fields are the brief's. The session, audio and mic
  messages are prefixed `Dictation…` (`DictationSessionRequest`,
  `DictationSessionEvent`, `DictationAudioFrame`, …) because every service shares the
  `codefoundry.v1` package and names carry the service noun. Watch's message and
  `DictationSessionEvent` carry a `heartbeat` field, per `heartbeat.proto`.
* **Not on EventService.** The host and the frontend both use `DictationService.Watch`.
  The state is small and changes rarely.
* **Commands**: `dictation.toggle` is a GUI action like `composer.history`. It emits
  ShowView `dictation.toggle` and is available once dictation is on with the model
  there; PR 4 adds the frontend presenter. `start`, `stop` and `status` are NoPalette
  and NoKeybinding (CLI verbs; the GUI has the toggle). `download`, `download.cancel` and
  `remove` stay in the palette (no prompt) with When by state. `dictation.*` is left out
  of the agent guide like `skill.*`: it is the user's microphone, not agent work, and the
  guide sits at its size budget.
* **One protocol definition.** The store speaks with `internal/dictate`'s methods,
  events and param types (PR 1's engine side, pure Go), so the two cannot drift.
  `EngineConn` is the daemon's client half; `dictate`'s Decoder/Encoder are the server's.
* `m1_family` matches the word `M1` in the brand string ("Apple M1 Pro"), not any
  substring.
* A stderr line that is the engine's own `level=INFO`/`DEBUG` logging is not appended to
  an exit error.

## Gotchas

* With the fake clock a test must not wait on "a timer is pending" alone: the store arms
  a timer a moment before it publishes the matching snapshot. Wait on both.
* `connect` server streams that send nothing block the client's call: anything a test
  (or the GUI) opens must send first.

## Verification

`make check` green. End to end with `CODE_FOUNDRY_HOME=/tmp/dict2-home` and
`CODE_FOUNDRY_DICTATE_BIN` pointing at a copy of PR 1's real `bin/code-foundry-dictate`
(v0.0.1-dict.1, Apple M3 Pro):

* `dictation status`: off, no model, "Apple M3 Pro, 36 GB".
* `dictation download`: progress at 2, 25, 63 MB; `dictation download.cancel` kept a
  64 MB `.part`. A second download resumed from it, finished in about 20 s, verified, and
  turned `dictation.enabled` on. The engine started and loaded the model (`load_ms`
  4603, about 1.17 GB footprint), then READY.
* A real session through `DictationService.Audio`: a throwaway feeder (not committed)
  streamed a 6 s `say` recording (16 kHz mono) at real time in 20 ms frames, then stopped
  with flush. The phrase "the quick brown fox jumps over the lazy dog. Dictation runs on
  this Mac, and audio never leaves it." arrived about 650 ms after Stop, before `ended
  STOPPED`, and Stop returned with it. 101 level events over 6 s.
* `dictation start` from the CLI, then a second client: refused (Aborted). The CLI session
  stopped itself after 30 s without audio.
* `settings set dictation.enabled false` killed the engine; true started a new one, READY.
* `kill -9` on the engine: LOADING, restarted after 1 s, READY.
* `dictation remove` asked for confirmation; with `--yes` the file was deleted and the
  engine stopped; state NO_MODEL. A daemon restarted with the model on disk loaded it at
  start, and a session transcribed again. Stopping the daemon left no engine process.

* After rebasing onto PR 1 (#395), again without `CODE_FOUNDRY_DICTATE_BIN`: the daemon
  found `bin/code-foundry-dictate` beside itself, loaded at start and transcribed the same
  recording.

Not exercised for real: the presence unload (it needs a GUI window; unit tests cover it
with a fake clock and presence) and the engine's memory-pressure `unloaded` (fake engine
only).
