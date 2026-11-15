# File previews 2: tail reads and media streaming (2026-11-14)

The daemon and API-layer half of the log and media previews (the series' brief: logs read the
LAST 1 MiB and open at the bottom; video and audio stream from the daemon, never a blob). No
UI here: the log view and the player build on what this adds.

## Tail reads

* `ReadFileRequest.tail` (`fsx.ReadTail`): a text file over the cap (`max_bytes`, at most
  1 MiB) comes back from the first line that starts in its last cap bytes. One byte more than
  the cap is read, so a window that begins just after a `\n` keeps its first line. A `\n`
  that is the file's last byte starts nothing (it would leave empty contents), so a window
  that is one long line falls back to its first whole UTF-8 character (skipping at most three
  continuation bytes). CRLF needs nothing special: the cut is after the `\n`.
* A file within the cap, and anything not text (binary, image, PDF), reads exactly as without
  `tail`: from the start, with `truncated` as before.
* The response says `truncated_start` and `offset` (the file's byte that `contents` begin at).
  `truncated` stays false on a tail read, so the two flags never mean the same thing.
  `size` is the whole file, so the GUI can say "Showing the last 1 MiB of 38 MB".
* **No first-line number.** Counting the lines before the window means reading everything
  before it: 37 MB for the 38 MB log, seconds for a multi-GB one, on every refresh. Not cheap,
  so it is left out; the log view numbers lines from the window (or not at all) and labels the
  cut by bytes.
* A tail read is not editable: `fsx.notEditable` refuses `TruncatedStart` like `Truncated`,
  and `canEdit` in `src/api/files.ts` refuses `truncatedStart`.

## Media

* `ReadFile` on a video or audio file reads no bytes: `media`, `binary`, `mime_type`, `size`,
  `modified_at` set, `contents` empty, `truncated` false. Media is decided by **extension only**
  (`fsx.MediaType`: mp4 m4v mov webm, mp3 wav m4a aac ogg flac), both for ReadFile and the
  route, so the two always agree; a sniffed video with another name stays a binary.
* `FilesystemService.StreamFile(base_dir, path)` answers `url` (root-relative,
  `/media/<grant>/<name>`), `mime_type`, `size`, `modified_at`. It opens the file by
  ReadFile's rules first (`fsx.OpenMedia`), so its errors are ReadFile's: InvalidArgument
  (outside home and the temp folders, a link leading out, traversal out of them, relative with
  no base, a directory, not regular, not media), NotFound, PermissionDenied (macOS privacy).

### The route's contract

`GET|HEAD /media/<grant>/<name>` on the **API listener**, outside CORS and the bearer check.

* Body: the file, whole (200) or the one range asked (206, `Content-Range`), any size, by
  `http.ServeContent`: `bytes=a-b`, `bytes=a-`, `bytes=-n`; a range past the end is 416 with
  `Content-Range: bytes */<size>`. `Accept-Ranges: bytes`.
* Headers: `Content-Type` from `fsx.MediaType`, `Cache-Control: no-store` (the file can change
  under the same URL), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Content-Security-Policy: sandbox` (opened as a document it runs nothing). **No CORS
  headers**: a media element loads without them, and no page may read the bytes.
* Every request runs `fsx.OpenMedia` on the path the grant was minted for: the file the path
  leads to now must be under home or a temp folder (symlinks resolved, the temp-folder open
  through a Root as ReadFile's), a regular file, and a media type by its name and by the name
  of the real file it leads to (so `clip.mp4 -> notes.txt` is refused, and so is a link to the
  daemon token). Anything refused is 404, like an unknown grant, a preview grant, a name
  that is not the file's base name, or a path below it. Other methods are 405.

### Decisions

* **The preview's grant table, a new kind of grant.** `Grants.GrantMedia(path)` mints in the
  same table as PreviewFile (same 16-byte hex ids, one per path, deduped), as an entry marked
  `media`. The preview route 404s a media grant and the media route anything else, so a
  grant only ever works where it was minted for. It is bound to the path as asked, not the
  real path: like ReadFile, what the path leads to is decided at each read.
* **ReadFile's rules, not the Floor.** A preview grant serves a tree of scripts and pages, so
  it is held to the Floor (no config home, no `~/.ssh`, no `~/Library`). A media grant serves
  one file of a media type, runs nothing, and its bytes reach no script, so it is held to
  exactly what ReadFile allows: a video under `~/Library` plays where ReadFile would show it.
  It gives nothing ReadFile does not already hand the GUI.
* **The API listener, not the pages listener.** The pages listener is where the preview's
  pages run; a media URL served there would be same-origin to every page, and a page that
  learnt a grant could `fetch()` its bytes. From a page the API listener is another origin
  that sends no CORS headers, so only an opaque response comes back. `daemon.withMedia`
  mounts it ahead of `loopbackHandler`, still inside `loopbackHost`. The Unix socket has no
  media route (the CLI plays nothing).
* **Lifetime: until the daemon stops,** like the preview's grants (a paused video resumed an
  hour later must still seek). An "expired" grant is one from before a restart: the new
  table never minted it, so it is 404. The table grows by one entry per media path played.
* **Not a file server:** `GrantMedia` refuses a non-media name (`ErrNotMedia`), `OpenMedia`
  checks the extension before it opens anything and again on the real file, and the route
  takes no path beyond the file's own name.
* **Race left open, as for ReadFile:** in a temp folder, a name can be swapped for a link to
  another file in the same temp folder between the check and the open. The open stays inside
  that folder (the Root), and the bytes go to a media element that cannot expose them, so the
  extension rule is the only thing such a race gets around.
* **Text types:** `.csv` `.tsv` `.log` were already text; `.patch` `.diff` are `text/x-diff`,
  `.mmd` `.mermaid` `text/vnd.mermaid`, `.jsonl` `.ndjson` `application/jsonl` (text by
  `TextMIME`). `.jsonl` was `application/json`; it changed so a JSON-tree previewer keyed on
  the MIME type does not try to parse a record per line as one document.

## How the GUI calls it (`src/api/files.ts`)

* **Tail:** `readFileTail(baseDir, path, conn?, signal?)` returns a `FileReadView` as
  `readFile` does. Check `truncatedStart`; then `offset` is where `text` begins and `size` the
  whole file ("Showing the last 1 MiB of 38 MB" from `size - offset` and `size`). The log view
  calls it instead of `readFile` for `.log`, and again on refresh. A daemon older than the
  option answers the head with `truncated` set and `truncatedStart` unset.
* **Media:** a read with `media` set (or `mediaKind(mime)` non-null) has no bytes. Call
  `streamFile(baseDir, path, conn?, signal?)`: it returns `{ url, mime, size, modifiedAtMs }`
  with `url` absolute on the daemon's base URL, ready for `<video src>` / `<audio src>`. Ask
  once per path, and again when the daemon's pid changes (as `usePreviewGrant` does) or the
  element fires `error` (the file went, or the daemon restarted: both 404).
* `truncatedStart`, `offset` and `media` are optional on `FileReadView` (absent: false/0), so
  views built by hand in tests stay valid; `toFileReadView` always sets them.

## Mock daemon

* `docs/media/clip.mp4` (3 s H.264 Baseline, 160×90, 2.7 KB, an orange bar sweeping across)
  and `docs/media/tone.m4a` (2 s 440 Hz AAC, 8.4 KB) under the code-foundry fixture checkout,
  from `gui/frontend/mock/media/`. Both play in the drive's WebKit. The video was written with
  an `AVAssetWriter` Swift script and the audio with `afconvert` from a generated WAV (no
  ffmpeg on the machine); its `moov` is at the end, so a player's first requests are ranges.
* `StreamFile` mints `mock-media-<n>`; `GET /media/<grant>/<name>` answers one range like
  ServeContent (`mock/media.ts` `byteRange`, unit tested), 416 past the end, no CORS.
* `ReadFile` with `tail` cuts as the daemon does (`tailOf`). `logs/server.log` is a
  small log; `POST /__mock/fs/log?bytes=N[&path=…]` writes a generated one (default 3 MiB at
  `~/src/code-foundry/logs/big.log`): timestamps, levels with ANSI colours on WARN/ERROR,
  numbered lines, the last one "line <n> · the end".

## Checked end to end

`make drive DAEMON=dev`, then with curl against the dev daemon: a 38 MB log's tail (offset
36951477, starting on a line, ending on a multi-byte character); ReadFile on an mp4 (media, no
bytes); StreamFile refusing a `.txt`, a `.mp4` link to a `.txt`, a directory, a missing file
and `/etc/hosts`; the route answering whole, `0-9`, a middle range, a suffix, 416, HEAD, POST
405, a wrong grant, a wrong name, the same URL on the pages listener (404), no CORS for
`Origin: null`, and 404 after the file was removed, replaced by a link to text or out of the
roots, then 200 when restored. In the drive's WebKit, `streamFile` from the app's own module
gave URLs a `<video>` and an `<audio>` played (readyState 4, 160×90, seeking to 1.5 s worked),
fetched as 206s in the daemon's request log.

## Gotchas

* Mock modules that `readFileSync` a `new URL(…, import.meta.url)` (`mock/files.ts` through
  `mock/pagelib.ts`) cannot be imported by vitest (jsdom URLs are not file URLs): pure helpers
  the mock's tests need live in `mock/media.ts`.
* A privacy refusal (EPERM from TCC) cannot be produced in a test; OpenMedia goes through the
  same open as ReadFile (`openRead`), whose mapping is tested.
