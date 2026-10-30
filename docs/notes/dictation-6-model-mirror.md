# Dictation 6: the model from the GitHub release, through gh

A user behind a corporate proxy got "Download failed: download failed: download
ggml-large-v3-turbo-q8_0.bin: 403 Forbidden": the proxy blocks huggingface.co. The updater
works on the same Mac because it reaches GitHub through the user's authenticated gh. The
model now does the same.

## What changed

* The registry entry has `Sources`, tried in order: the release asset first
  (`alexwaumann/code-foundry`, tag `models-whisper-large-v3-turbo-q8_0`, pre-release, asset
  `ggml-large-v3-turbo-q8_0.bin`, same size and sha256), then the Hugging Face URL. Still
  data: a source is a `ReleaseAsset` or a `URL`.
* The GitHub source runs `gh api repos/<repo>/releases/tags/<tag>` (30 s bound), finds the
  asset by name in the JSON in Go (no `--jq`: the fake gh serves plain JSON), checks it is
  `uploaded` and of the pinned size, then streams
  `gh api --include -H "Accept: application/octet-stream" [-H "Range: bytes=N-"]
  repos/<repo>/releases/assets/<id>` into the `.part`. The bytes go through the same
  meter (≤ 4 Hz) and the same sha256 check as the URL source.
* gh is `advanced.gh_path` (read on every run, so a changed path applies without a
  restart), else `gh.LookPath()`. It runs in its own process group; cancel kills the
  group. No gh, or gh without a login (exit 4 / "gh auth login"), skips the source with an
  Info log line and its reason.
* Fallback: any failure moves to the next source, which resumes the `.part` the last one
  left (every source serves the same bytes). A sha256 mismatch empties the part first, so
  the next source starts from zero rather than build on damaged bytes; a part left empty
  is deleted. Cancel never falls through.
* Wording: the store's `"download failed: "` prefix is gone. The snapshot error is
  `Download failed: <reason>` for one source, or `Download failed:` and a
  `<source>: <reason>` line per source. The settings row dropped its own `Download
  failed: ` and renders the lines (`whitespace-pre-line`); `dictation status` puts a
  multi-line error on lines of its own. A proxy refusing the CONNECT reads "could not
  connect through the proxy: Forbidden"; a proxy that answers the request itself reads
  "the server answered 403 Forbidden".
* `runDownload` closed `done` before publishing the final snapshot, so `CancelDownload`
  could return a stale DOWNLOADING snapshot (the new tests caught it under `-race`). It
  closes after the publish now.

## Resume: Range passes through gh

`gh api -H "Range: bytes=N-"` sends the header to api.github.com, and Go's client keeps
it across the 302 to the object store (release-assets.githubusercontent.com), which
answers 206 with `Content-Range`. Checked by hand (`--include` showed `HTTP/2.0 206
Partial Content`, 75 bytes for `bytes=874188000-`) and in the live run below. So the
GitHub source resumes like the URL one. `--include` prints the final response's status
line and headers (not the redirect's) before the body; the fetcher reads up to the blank
line, so a 200 (range ignored) starts over and a 416 empties the part, the same rules as
the URL source. A range at the end of the file is a 416 from gh (exit 1, "gh: HTTP 416").

## Decisions

* The repository is pinned in the registry instead of `version.Repo()`: dev builds have
  no release repo, and `CODE_FOUNDRY_RELEASE_REPO` pointed elsewhere for an update test
  should not lose the model.
* Labels are "GitHub" and the URL's host, so the lines read `GitHub: …` and
  `huggingface.co: …`.

## Gotchas

* `cmd.Stdout` set to an `io.Pipe` writer: if the reader stops early, gh blocks on its
  pipe and `Wait` never returns. The fetcher cancels the run and closes the reader on any
  early stop.
* A killpg racing the shell's fork can miss the new child (seen once in the cancel test
  under `-race`); the test's script forks before it prints. gh itself does not fork.

## Verification

`make check` green; `go test -race -count=10 ./internal/store/dictation/` green. Tests:
table tests with the fake gh (`dictationtest.Gh`) and httptest for the order (GitHub
first; a blocked URL first falls back to GitHub), skipping (no gh, logged out, asset still
uploading, no release), resume across sources, range ignored, damaged file not resumed,
cancel (gh killed, part kept, resumed with `Range: bytes=1500-`), progress from the gh
path, a proxy refusing CONNECT, and the exact error text; `ExecGh` against a scripted gh
(stdout, exit 4, 404, missing, cancel kills the group). e2e: the settings row shows the
prefix once and a line per source (mock `state=download-failed`).

Live, `CODE_FOUNDRY_HOME=/tmp/dict6-home`, Apple M3 Pro, home network:

* No model, `dictation download`: the log said `source=GitHub from_byte=0`; gh streamed at
  about 34 MB/s with about 50 MB RSS. `download.cancel` killed gh (no process left) and
  kept a 266 MB part. The next download ran `gh api ... -H "Range: bytes=266219928-"` and
  finished 15 s later, verified, `source=GitHub`; dictation turned on and the engine
  loaded the model. sha256 on disk matched.
* Behind a local CONNECT proxy that answers 403 for huggingface.co and tunnels the rest
  (`HTTPS_PROXY` on the daemon): from zero, served by GitHub in 14.9 s; the proxy log
  showed api.github.com and release-assets.githubusercontent.com.
* Same proxy, `advanced.gh_path` at a stand-in gh that exits 4 like a logged-out gh:
  "Download failed:" / "GitHub: gh is not logged in (run gh auth login)" /
  "huggingface.co: could not connect: Forbidden" (before the proxy wording above).
* No proxy, the logged-out gh: GitHub skipped, huggingface.co resumed the 214 MB part the
  GitHub run had left (`from_byte=213735040`) and finished 13.6 s later, verified.
* The reverse order (Hugging Face blocked first, then GitHub) is covered by the table
  test only; the registry never puts the URL first.
