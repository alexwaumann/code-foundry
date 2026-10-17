# PDF attachments 1: daemon

The daemon accepts PDFs as staged attachments next to the four image types and sends
them to Claude Code the way Claude Code sends a pasted PDF.

## Decisions

- **Inline threshold 10 pages, Claude Code's own rule.** A PDF of at most
  `MaxInlinePDFPages` (10) goes as a base64 `document` block after the text block
  (`claudestream.DocumentBlock`; `ImageSource` became `MediaSource`, shared by both). A
  longer one goes only as its path, and the prompt line tells Claude to page through it
  with Read (`pages` is required above 10 pages, at most 20 per call). Lines:
  - `Attached image: <path>` (unchanged)
  - `Attached PDF: <path> (2 pages)`; `1 page`; `about N pages` when estimated
  - `Attached PDF: <path> (30 pages, not sent inline); read it with the Read tool's pages
    parameter, at most 20 pages per call`
- **Page count, settled once at stage time.** `StageAttachmentRequest.pages` is the
  client's count (the GUI counts with pdf.js; 0 = unknown). `settlePDFPages` takes
  poppler's `pdfinfo` (3 s timeout, the `Pages:` line) when installed, else the hint,
  both exact, else ceil(size/100 KiB) like Claude Code (an estimate, so the line says
  "about"). pdfinfo is looked up on `$PATH`, then in `/opt/homebrew/bin` and
  `/usr/local/bin`, because a Finder-launched daemon has launchd's minimal PATH (the
  same reason as `gh.LookPath`). Without the hint the GUI (exact, pdf.js) and a daemon
  without pdfinfo (estimate) disagreed on "at most 10 pages" and on the inline cap, and
  a 150-page PDF of 900 KB went whole (the API takes at most 100 pages).
- **The count lives in the file name.** A PDF is stored as `<32 hex>-<N>p.pdf` (exact)
  or `<32 hex>-~<N>p.pdf` (estimate); images keep `<32 hex><ext>`. StageAttachment
  writes `<32 hex>.pdf`, settles the count and renames. `messageAttachments` (Create and
  Send) reads the count back with `stagedPDFPages`; a name without one (staged before
  this change, within `AttachmentMaxAge`) falls back to `pdfPages`, pdfinfo or the
  estimate. `checkAttachments` takes any regular file directly in the directory, so
  both shapes pass. The prompt line and the inline decision in `sendMessage` use the
  same `[]attachment` on `outgoing`; items still store only paths.
- **Caps.** Images stay at 10 MiB (`MaxAttachmentBytes`); PDFs may be 20 MiB
  (`MaxPDFAttachmentBytes`). The limit follows the sniffed content, not the declared
  type. `MaxMessageMediaBytes` (24 MiB raw) bounds what one message sends **inline**
  (images and PDFs of at most 10 pages), since the API takes 32 MB per request with
  base64 (+33%). A long PDF that only goes as its path does not count: it is not in the
  request. `ReadAttachment` serves PDFs up to 20 MiB and images still only up to 10.
- **`media_removed` is Claude Code's job.** When a later request would be too large,
  Claude Code strips old media blocks and tells Claude to read pages from the path
  instead; that works because every spawn passes `--add-dir <attachments dir>`, so the
  Read needs no permission prompt.
- CLI: `thread items` prints `[pdf <path>]` for `.pdf` attachments, `[image <path>]`
  otherwise; `thread new` and `thread send` say "image or PDF paths".

## Gotchas

- Tests build a PDF by hand (`testPDF(n, pad)` in `pdf_test.go`: catalog, pages, a
  Helvetica font, one page and content stream per page, xref). pdfinfo 26.10 reads it
  without warnings and pdftotext extracts "Page i of n". `pad` adds a comment after the
  header to grow the file, which moves the estimate without changing pdfinfo's count;
  the stream test passes the true count as the hint, so it holds on a CI runner without
  poppler. `TestPDFPagesPdfinfo` and the pdfinfo case of `TestStageAttachmentPDFPages`
  skip there; `noPdfinfo(t)` hides pdfinfo for the hint and estimate cases.
- The page count is in the path Claude sees (`…-30p.pdf`). Harmless, and it keeps the
  count with the file without a table or a sidecar.
- There is still no CLI verb for StageAttachment; the end-to-end check below staged with
  curl against the Connect JSON endpoint over the socket.

## Verified end to end

After the rebase onto the thread rename and the stage-time count: scratch daemon
(`CODE_FOUNDRY_HOME=/tmp/cf-pdf-home`), PDFs staged with `curl --unix-socket …
/codefoundry.v1.ThreadService/StageAttachment` (JSON, `pages` as the hint), pdfinfo
installed:

| file | bytes | hint | stored as | log |
|---|---|---|---|---|
| 2 pages, "The secret fruit is mango, page N" | 894 | 2 | `2c50…-2p.pdf` | pdfinfo, exact |
| 30 pages, "Chapter on kiwi farming, page N" | 8975 | 99 | `13dd…-30p.pdf` | pdfinfo wins over the hint |
| `%PDF-1.4` + 900 KiB of junk (pdfinfo fails) | 921609 | 150 | `7e33…-150p.pdf` | the hint |
| the same junk | 921609 | 0 | `88dc…-~10p.pdf` | the estimate |

`thread new --no-project --model 'claude-haiku-5-5[1m]' --effort medium --prompt
"Without using any tools: which attachments do you have, how many pages does each
have, and what is the secret fruit? Answer briefly." --attachments <2p>,<30p>,<150p>`.
The transcript's user message:

```
Attached PDF: /tmp/cf-pdf-home/attachments/2c50…-2p.pdf (2 pages)
Attached PDF: /tmp/cf-pdf-home/attachments/13dd…-30p.pdf (30 pages, not sent inline); read it with the Read tool's pages parameter, at most 20 pages per call
Attached PDF: /tmp/cf-pdf-home/attachments/7e33…-150p.pdf (150 pages, not sent inline); read it with the Read tool's pages parameter, at most 20 pages per call
```

followed by one `document` block (`application/pdf`, 1192 base64 chars): the 900 KB
"150-page" file, which the size estimate alone would have sent whole, went only as its
path. Haiku answered 2, 30 and 150 pages and "mango" from the document block, without a
tool call.

Before the rebase (same setup, `SessionService` then), a follow-up asking for page 25
of the 30-page PDF made Claude call `Read {"pages":"25"}` on it ("PDF pages extracted:
1 page(s)") and quote "Chapter on kiwi farming, page 25".
