# Dictation 1: the engine, its build and packaging

PR 1 of five (design: the dictation brief, 2026-10-29). Adds `code-foundry-dictate`, a
third executable that the daemon will run (PR 2) to turn microphone audio into text on
this Mac. Nothing calls it yet.

## What shipped

* `scripts/whisper-cpp.sh` builds whisper.cpp **v1.9.5** (commit
  `d1be6fde11ac6e0407606b4e42fe72d34add8037`, the latest release on 2026-10-29; the
  script fails if the tag moves) with cmake into
  `~/Library/Caches/code-foundry/whisper-cpp/<key>/whisper-cpp`, like `ghostty-vt.sh`.
  Key = tag + arch + the first 8 hex of the sha256 of the cmake flags
  (`whisper-cpp-v1.9.5-arm64-d3ad7bc7`). `--print-key`, `--print-prefix`,
  `WHISPER_CPP_CACHE`. A cold build takes about 15 s on an M3 Pro. The source and build
  tree are deleted afterwards (the prefix is about 30 MB).
* The script writes its own `share/pkgconfig/whisper-cpp-static.pc` listing every static
  library in link order plus the frameworks (Accelerate, Foundation, Metal, MetalKit,
  libc++); cgo uses `#cgo pkg-config: whisper-cpp-static`. whisper.cpp's own `whisper.pc`
  is not enough for a static link. The `.pc` is written last, so it marks a finished build.
* `make whisper-cpp`; `build`, `go-lint`, `go-test` and `package` depend on it. `make build`
  also writes `bin/code-foundry-dictate`. The Makefile adds the prefix's pkgconfig to
  `PKG_CONFIG_PATH`.
* CI: the existing `setup-go-ghostty` composite action gained the whisper.cpp steps (cache
  on `--print-key`, then `make whisper-cpp`) instead of a second action, because the Go
  build cache key has to include `scripts/whisper-cpp.sh` anyway (see Gotchas) and that key
  lives in the same `setup-go` step. ci.yml and release.yml already use the action. cmake
  is preinstalled on the macOS runners.
* `internal/dictate` (pure Go): the protocol codec, the segmenter, the filters, the server
  loop over a `Backend` interface, a WAV reader. `internal/dictate/whisper` (cgo): the
  model actor. `cmd/code-foundry-dictate`: flags and wiring.
* Packaging: `package.sh` copies, ad-hoc signs and checks `code-foundry-dictate --version`,
  and the tarball listing check expects four names. `install.sh` installs whatever the
  tarball holds; when `code-foundry-dictate` is there it must be an executable file. It is
  optional so `--version` installs of older releases keep working. The update store runs the
  embedded installer and never lists the tarball, so it needed no change.

## Pins

| What | Value |
| --- | --- |
| whisper.cpp | v1.9.5, `d1be6fde11ac6e0407606b4e42fe72d34add8037` |
| cmake flags | Release, arm64, deployment target 13.0, static, `GGML_NATIVE=OFF`, Metal + embedded library, no examples/tests/server |
| Silero VAD | `ggml-silero-v5.1.2.bin` from huggingface.co/ggml-org/whisper-vad, 885,098 bytes, sha256 `29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf` (MIT), committed in `internal/dictate/whisper/` and embedded |
| Whisper model (for PR 2's registry) | `ggml-large-v3-turbo-q8_0.bin`, 874,188,075 bytes, sha256 `317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1` |

## Decisions

* **`GGML_NATIVE=OFF`.** A release is built on a CI runner. `-mcpu=native` there could
  emit instructions an M1 lacks. Metal does the heavy work anyway.
* **One actor for every C call.** `whisper.Engine` runs a goroutine locked to its OS
  thread. The exported methods send it closures and wait (the terminal actor's `reqs chan
  func()` pattern). `do` after `Close` is a no-op, never a panic.
* **The server loop is synchronous; the inbox is unbounded.** The stdin reader parses
  lines into an unbounded FIFO, so the daemon can keep writing audio while whisper works
  on a phrase (a second or so). The loop then catches up on the queued audio. VAD on 32 ms
  windows is far faster than real time.
* **The VAD runs on the CPU** (`use_gpu=false`, 1 thread). It is a small LSTM called every
  few frames. Streaming uses `whisper_vad_detect_speech_no_reset` and resets at `begin`.
  The model loads from memory through a `whisper_model_loader` over the embedded bytes, so
  there is no temp file.
* **Segmentation** (`DefaultSegmentConfig`): speech at p ≥ 0.5, silence below 0.35 (between
  the two, the silence count holds). An onset is confirmed after 250 ms of speech; shorter
  bursts are dropped silently. A phrase closes after 500 ms of silence, keeps 200 ms of
  pre-pad and 200 ms of trailing silence, and is cut at 25 s (speech then goes on in the
  next phrase). Phrases under 1 s are padded with silence to 1 s for whisper.
* **Whisper params:** greedy, best_of 1, `language=en`, no detection, `single_segment`,
  `no_timestamps`, `suppress_nst`, temperature 0 with `temperature_inc=0` (no fallback),
  `no_context=true` with our own `initial_prompt` (the previous phrase's tail, ≤ 200 bytes
  cut at a word boundary; cleared on `begin`/`end`). Threads = `hw.perflevel0.physicalcpu`
  (6 on an M3 Pro). `use_gpu` and `flash_attn` are on.
* **Warm-up on load:** one whisper run over 1 s of silence, so the first phrase does not pay
  for Metal's pipeline compilation. `load_ms` includes it.
* **Filters** (`filter.go`, list in `hallucinations.go`): `[...]` annotations and ♪ are
  stripped. A phrase that is only `(…)` or `*…*` is dropped. Whole-phrase matches against
  the normalized silence list are dropped ("Thank you.", "Thanks for watching", "you",
  "Bye." …), as are subtitle-credit markers anywhere ("subtitles by", "amara.org" …).
  N-gram loops (n ≤ 8, four repeats of one word or three of a longer run) collapse to
  their last copy, which keeps the closing punctuation. The rest of the phrase is kept.
  The loop collapse runs before the list check, so "Thank you. Thank you. Thank you." is
  dropped.
* **`rss_bytes` is the physical footprint** (`TASK_VM_INFO.phys_footprint`, what Activity
  Monitor shows; Metal buffers included), not `ru_maxrss`.
* **Memory pressure:** a `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE` (warn|critical) source,
  with a C handler on a libdispatch thread that writes one byte to a pipe. The handler
  never enters Go. A goroutine reads the pipe into the server's inbox. Warn while
  listening defers the unload until the session ends. Warn while ready, or critical at
  any time, unloads at once (ending a session without flush). Either way the engine emits
  `state idle` and then `unloaded {reason:"memory-pressure"}`.

## Protocol details for PR 2 (beyond the brief)

* On start the engine emits `state {idle}` once. stdin EOF, `shutdown` (reply first) and
  SIGINT/SIGTERM all exit 0, and the models are freed first.
* Session ids are strings. `begin` without a loaded model is an error reply ("the model is
  not loaded"). `begin` while a session is open replaces it (a `speech {active:false}`
  first if speech was open).
* `end` for a session that is not open is `{}` (idempotent). With `flush`, the phrase
  event (if any) comes before the `state {ready}` and the reply. Without flush, pending
  speech is dropped (with `speech {active:false}` if it was open).
* `speech {active:true}` fires once 250 ms of speech is confirmed, not on the first voiced
  window. `speech {active:false}` comes before the phrase's `transcribing` state and the
  phrase itself.
* `load` is idempotent while loaded. `language` other than "" or "en" is an error. A
  missing file is an error with `state loading → idle`.
* `unload` while listening ends the session silently (`speech false` if needed, `ready`,
  `idle`). The daemon decides what the user sees.
* Audio frames can be any even byte length. An odd length, or a malformed line, is an
  `error` event and the engine goes on. A line over 4 MiB is fatal.
* Where to find the executable: next to `code-foundry` in an install
  (`update.RunningDir()`), or `bin/code-foundry-dictate` in a dev build.
* After `unload` the process footprint stays around 170 MB (ggml/Metal residue). For the
  10-minute presence unload, exiting the engine (`shutdown`) gives back more than `unload`.

## Verification (Apple M3 Pro, 36 GB, macOS 27.0.1)

`make check` green. `make package VERSION=v0.0.1-dict.1` produced a four-entry tarball.
`dist/install.sh` from a local release dir installed it into `CODE_FOUNDRY_HOME=/tmp/…`.
The installed, ad-hoc signed `code-foundry-dictate --version` printed the version, and
`--transcribe` worked from the install dir.

Audio: `say -o x.aiff …; afconvert -f WAVE -d LEI16@16000 -c 1 x.aiff x.wav`, then two
such clips joined with 1.5 s of silence and 3 s of low noise (18.2 s in total):

```
$ code-foundry-dictate --transcribe xy.wav --model ggml-large-v3-turbo-q8_0.bin
dictate: loaded load_ms=844 rss_bytes=1163511584 whisper=1.9.5-dev
{"text":"Let's add a retry to the fetch step, then rerun the tests and open a pull request when they pass.","start_ms":320,"end_ms":5952,"infer_ms":632}
{"text":"Ok, next, rename the session store to thread store, and update every caller in the daemon.","start_ms":7264,"end_ms":13248,"infer_ms":730}
dictate: transcribed audio_ms=18224 wall_ms=1396 phrases=2
```

* Load: 4.8 s cold (first read of the 874 MB file), 0.84 s warm, warm-up included.
  Footprint while loaded is about 1.16 GB.
* Inference: 0.63–0.73 s per 5.6–6 s phrase. 7 s of silence and noise gave no phrases
  (12 ms).
* Live protocol (a Python driver feeding 100 ms frames in real time): `speech false` came
  0.5 s after the last word and the phrase 0.7 s later. So text lands about 1.2 s after
  you stop talking. `end {flush}`, `status`, `unload` (footprint dropped to 171 MB),
  `shutdown` and exit 0 all behaved as specified.

Not verified live: the memory-pressure dispatch source. `memory_pressure -S -l warn`
needs root (`kern.memorypressure_manual_trigger: Operation not permitted`). The server's
handling is covered by unit tests with a fake pressure channel. Left for PR 5.

## Gotchas

* Go does not key its build cache on a cgo package's pkg-config link path (same as
  libghostty-vt, `ghostty-vt-shared-cache.md`). The CI Go cache is now keyed on
  `scripts/whisper-cpp.sh` too. Locally, after a pin bump, `go clean -cache` if a link
  fails against an old prefix.
* `whisper_version()` reports `1.9.5-dev` at the v1.9.5 tag (upstream's CMake version
  string). Harmless.
* v1.9.5 also builds `libparakeet.a`. The `.pc` does not link it.
* ggml logs several INFO lines per VAD call. The log callback keeps WARN and up on stderr.
  stdout is the protocol, and nothing else may write to it.
* The pipe's write end lives in a package variable: if the `*os.File` were collected, its
  finalizer would close the fd the C handler writes to.
* cmake is the one new dev dependency (`brew install cmake`; 4.4.4 here). The script says
  so when it is missing.
