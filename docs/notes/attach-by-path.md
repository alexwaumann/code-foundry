# Attach by path: daemon half

Files dropped on the composer or picked in the native file dialog reach the GUI as
absolute paths (WebKit never exposes a dropped File's path; the Wails host hands paths
over). This PR lets `ThreadService.StageAttachment` stage such a path without the GUI
reading and uploading the bytes. The GUI half (a later PR) stages the five supported
types this way and inserts anything else as a path at the caret.

## Decisions

- **One RPC, one new field.** `StageAttachmentRequest.path = 5`. Exactly one of `data`
  and `path` is set; both is InvalidArgument ("set either data or path, not both") in
  the handler. `data` is unchanged. `name` and `mime_type` may be empty with `path`: the
  name is the path's base (logs only, as before) and the type is sniffed. A `mime_type`
  sent with a path is still checked like the bytes path (declared vs content).
- **A thin front, not a second implementation.** `Manager.StageAttachmentFile` stats,
  sniffs and checks the cap, then hands a writer func to `stageAttachment`, which the
  bytes path uses too: random 32-hex stem, `O_EXCL` 0600 file, PDF page count settled
  with `settlePDFPages` (pdfinfo, else the hint, else the estimate) and recorded in the
  name. `attachmentType` became `declaredAttachmentType` + `contentAttachmentType`
  (head bytes and a size instead of the whole buffer); the caps and their messages
  (`attachmentLimit`, `attachmentTooLarge`) are shared.
- **Caps before reading, copy streamed.** The cap (10 MiB image, 20 MiB PDF, by the
  sniffed type) is checked against the stat size before any copy; the copy is
  `io.Copy` through `io.LimitReader(limit+1)`, so a file that grows past the cap
  meanwhile is refused and its partial copy removed.
- **Errors.** Relative path, directory, FIFO or other non-regular file, unreadable file:
  InvalidArgument. Missing: NotFound, with the message `attachment "<path>" does not
  exist` (a small `attachmentNotFound` type that `Is(ErrNotFound)`, so the composer does
  not show "thread not found"). Unsupported content gets the bytes path's
  unsupported-type message with the sniffed type, e.g. `attachment type "text/plain;
  charset=utf-8" (want image/png, image/jpeg, image/gif, image/webp or
  application/pdf)`. Stat runs before open because opening a FIFO blocks.
- **Same user, any readable absolute path.** No allow-list: the daemon is the user's
  own process and the GUI only sends what the user dropped or picked.
- The mock daemon (`mock/world.ts` `stageAttachmentPath`) takes the type from the
  extension, since it has no files, so the GUI PR can drive drops in e2e.

## For the GUI PR

Call `stageAttachmentPath(path, pages?)` from `@/api/threads` (same `Promise<string>`
as `stageAttachment`; it rejects with `OutdatedDaemonError` on Unimplemented). Only call
it for the five supported extensions, and insert any other path at the caret without
asking the daemon. On a ConnectError show `err.rawMessage` as the composer notice: it is
the unsupported-type message for content that does not match its extension, the cap
message for a large file, and `attachment "<path>" does not exist` for a vanished one.
There is no pdf.js count for a path-staged PDF; leave `pages` null and the daemon uses
pdfinfo or the estimate. The client-side size precheck needs the size from the host
(or can be skipped; the daemon enforces it).

## Gotchas

- `http.DetectContentType` calls SVG `text/plain; charset=utf-8` (no xml prolog), so a
  dropped SVG gets the same refusal as a text file.
- There is still no CLI verb for StageAttachment, so the end-to-end check was curl
  against the Connect JSON endpoint over the socket.

## Verified end to end

Scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cf-attach-path/home`, pdfinfo installed), curl
over `daemon.sock` with the token:

| request | result |
|---|---|
| `path` = `…/red square.png` (16x16 PNG) | `attachments/<hex>.png`, logged `name="red square.png" bytes=80` |
| `path` = `…/report.pdf` (3 pages), `pages: 9` | `attachments/<hex>-3p.pdf` (pdfinfo over the hint) |
| `path` = `…/notes.txt` | invalid_argument, `attachment type "text/plain; charset=utf-8" (want …)` |
| `path` = `…/huge.png` (11 MiB) | invalid_argument, `the limit for an image is 10 MiB` |
| `path` = `…/missing.png` | not_found, `attachment "…/missing.png" does not exist` |
| `path` = `files/notes.txt` | invalid_argument, `is not absolute` |
| `path` = `…/somedir` | invalid_argument, `is a directory` |
| `path` and `data` | invalid_argument, `set either data or path, not both` |

Refusals left nothing in `attachments/`. `ReadAttachment` on the staged PDF returned
`application/pdf` and bytes identical to the source.
