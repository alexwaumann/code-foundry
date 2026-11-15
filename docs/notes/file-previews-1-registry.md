# File previews 1: the preview kind registry

PR 1 of the file-format previews series (tables and JSON, Mermaid, patches, logs, media
follow). Frontend only, no daemon or proto change. The File tab's markdown, HTML, image and
PDF branches move onto a registry of preview kinds, SVG becomes the first new kind (Image |
Source), and the header gains Copy contents.

## Files

| Path | What |
| --- | --- |
| `src/components/files/previews/types.ts` | `PreviewKind` and the props a kind's body and controls get; `SOURCE` |
| `src/components/files/previews/registry.ts` | `PREVIEW_KINDS` (a glob of `kinds/*`), `previewKindOf`, `previewModes`, `pickMode`, `registryProblems` |
| `src/components/files/previews/kinds/*.ts` | one kind per file: `markdown`, `html`, `image`, `svg`, `pdf` |
| `src/components/files/previews/*Body.tsx`, `meta.tsx`, `SavedAgo.tsx` | the bodies and meta lines those kinds use |
| `src/components/files/FileTab.tsx` | asks the registry; knows no kind by name |
| `src/components/files/FileHeader.tsx` | `CopyContentsAction`, `FileActions`' `contents` |
| `src/components/code/CodeFile.tsx`, `files/CodeBody.tsx` | an optional `lang` (a kind's Source language) |
| `src/stores/codeView.ts` | `preview` is now `Record<kindId, modeId>` |
| `mock/files.ts` | `docs/logo.svg` |
| `e2e/file-previews.spec.ts` | SHOTS-gated screenshots only |

## Decisions

- **A kind is a file, found by a glob.** `registry.ts` loads every `kinds/*.{ts,tsx}` with
  `import.meta.glob(..., { eager: true })` and takes each default export. Adding a preview
  touches no shared file, so the five PRs after this one cannot conflict in the registry. The
  order kinds load in does not matter: matching goes by tier across all kinds (an extension,
  then an exact mime, then a wildcard mime like `image/*`, then a sniff of the text), and
  `registryProblems` (asserted empty by `registry.test.ts`) fails the suite when two kinds
  claim the same id, extension or mime, or a kind lists Source itself.
- **A kind that cannot show the read gives way.** `shows(file)` (default: the read has text)
  is checked after a match; a binary `.md`, a `.png` that is not a picture, fall through to the
  next match and then to the code view or the binary state, as before.
- **Source is added, never declared.** A kind lists its preview modes (first is the default);
  the switch appends Source whenever the read has text. A kind with one mode and no text (a
  raster image, a PDF, later video and audio) has no switch. The patch's Unified | Split is not
  a mode: it is the kind's `Controls`, shown after the switch in a preview mode only.
- **Mode memory is per kind id**, still one choice for the whole app (codeView `preview`). The
  store keeps any string (it knows no kinds); `pickMode` takes the remembered mode only when
  this read's switch has it, else the kind's first. Existing stores carry over unchanged:
  markdown and HTML keep the ids `rendered` and `source`.
- **Edit goes to Source.** As markdown did: while editing, the tab shows Source for that tab
  only (the remembered mode stays); picking a preview mode leaves edit mode; the switch hides
  while dirty. This is now the rule for every text kind. `edit: false` drops the pencil (image,
  PDF; later video, audio). SVG does not set it: `canEdit` already refuses an image
  (internal/fsx/editable.go), and that rule is unchanged, so an SVG has no pencil.
- **Meta.** In a preview mode row two shows `kind.meta(file)`, which the body may replace by
  calling `onMeta` (an image's size once it decodes, a PDF's page count). What the body said is
  keyed by path, kind and mode, so a re-read keeps it and switching modes drops it. Source
  shows `N lines · size · language`, the language from the kind's `source.name` when it has
  one (SVG), else the highlighter's.
- **Header actions follow the kind.** The wrap toggle shows in Source and in a preview mode
  whose kind sets `wrap`; find works in Source and in a preview whose kind sets `find`
  (markdown). An SVG's Image mode lost the wrap toggle it used to show by mistake.
- **Copy contents** sits right after Copy path, with the same check for a moment. It shows for
  a whole text read only (not a truncated one, nor a tail read: that would copy part of the file silently; not
  images, PDFs, binaries, folders). It copies the draft while editing, `kind.copy(file)` in a
  preview mode when the kind has one (tables will copy tab-separated text), else the text.
- **Too large.** `tooLarge: "Image"` makes a cut read show "Image · 48 MB · too large to show"
  (test id `file-<kind>-too-large`) in the preview mode. A truncated SVG still has Source.
- **SVG Source is highlighted as XML.** @pierre/diffs maps no `.svg`, so `source: { lang:
  "xml", name: "SVG" }` passes `lang` through CodeBody to the library's `FileContents.lang`.
- **Reads.** `read?: PreviewRead` (types.ts): "whole" (the default, `readFile`) or "tail"
  (`readFileTail`, the log kind's: file-previews-6-logs.md). Which read a file gets has to be
  known before reading, so it is the read of `previewKindOf(path, null)` (extension only);
  FileTab's `READS` maps each value to its call and `readTarget` uses it for every read of
  the tab (the first, a found path, an edit session's). A kind with a new read adds its value
  to `PreviewRead` and one entry to `READS`. FileTab says "Showing the last 1 MiB of 38 MB"
  when a read's `truncatedStart` is set, whatever the kind.
- **Bodies in their own files.** oxlint's `react/only-export-components` refuses a component
  in a file whose default export is a kind, so a kind file holds the object and its body lives
  beside it (`previews/<Name>Body.tsx`).

## How to add a preview

1. **The body.** `src/components/files/previews/<Name>Body.tsx` exporting
   `function <Name>Body(props: PreviewBodyProps)`. It gets the read (`file`), `path`, `mode`,
   `name`, `place`, `findKey`, `onMeta` and `onMode`. Call `onMeta(...)` when it learns something for
   row two (`Flowchart · 9 nodes · 312 B · Mermaid`). Call `onMode(SOURCE.id)` to offer Source
   from a state that cannot show the file (added by PR 4: a diagram that does not parse); it
   does what the switch does, so the choice is remembered for the kind. Virtualize long
   content (CLAUDE.md).
2. **The kind.** `src/components/files/previews/kinds/<id>.ts` with a default export:

   ```ts
   import { lazy } from "react";
   import { formatSize } from "../../fileKind";
   import type { PreviewKind } from "../types";

   const mermaid: PreviewKind = {
     id: "mermaid",
     match: { ext: ["mmd", "mermaid"] },
     modes: [{ id: "diagram", label: "Diagram" }],
     // A heavy library stays out of the main bundle: FileTab renders the body under Suspense.
     Body: lazy(() => import("../MermaidBody").then((m) => ({ default: m.MermaidBody }))),
     meta: ({ file }) => `${formatSize(file.size)} · Mermaid`,
   };

   export default mermaid;
   ```

   That file is the registration: no other file changes. Optional fields (types.ts says what
   each does): `mime`/`sniff` in `match`, `shows`, `Controls`, `wrap`, `find`, `edit: false`,
   `copy`, `tooLarge`, `source`, `icon`, `read`. A sniff runs on every text file once per read:
   one cheap scan (`text.includes("\u001b[")`), never a parse.
3. **Vitest.**
   - Matching: add rows to the `it.each` in `previews/registry.test.ts` (`"diagram.mmd" →
     "mermaid"`, and a near miss that must stay `null`). The "none claims what another does"
     test catches a clash with another kind.
   - The body: a test file of its own beside it (`previews/<Name>Body.test.tsx`) rendering
     `<NameBody file={...} path=... mode=... onMeta={vi.fn()} onMode={vi.fn()} ... />` with a `FileReadView`
     made from `blankFile(path)` plus `text`; assert what it draws and what it passed `onMeta`.
     Pure parsing (CSV rows, log levels) goes in a `.ts` with its own table test.
   - The header (switch labels, which actions show, what Copy contents copies) only when the
     kind changes what FileTab shows: add an `it` to `describe("previews")` in
     `FileTab.test.tsx` (`files.set(path, {...})`, `open(path)`; `copied.fn` is the clipboard).
4. **A mock fixture**, for `make drive` and the screenshots: one line in `fixtures()` in
   `gui/frontend/mock/files.ts`, beside `docs/logo.svg`:
   ``[`${CF}/docs/flow.mmd`, text(FLOW_MMD, "text/plain; charset=utf-8")],`` with the
   content as an exported constant above `PREVIEW_HTML`. Use the mime the daemon reports
   (`internal/fsx/read.go`: by extension, `text/plain` for unknown text). Binary content is
   `{ data, mime, binary: true }`.
5. **Screenshots** for the PR: add steps to `e2e/file-previews.spec.ts`'s SHOTS test
   (`openFile(page, "docs/flow.mmd")`, then `shot("mermaid")`) and run
   `SHOTS=<dir> bunx playwright test e2e/file-previews.spec.ts` in `gui/frontend`.
6. Check by hand: `make drive` (mock) or `make drive DAEMON=dev`, open the file with
   `openFileInPanel` (see the spec), and try an empty file, a huge one, a malformed one.

## Gotchas

- A kind file must not define a component (the lint rule above); keep JSX out of it unless it
  is in a `meta` return value.
- `previewKindOf(path, null)` sees extensions only. A kind that needs a read of its own must
  match by extension.
- `.txt` stays the code view: no shipped kind matches it, and only a sniff could.
