# File previews 5: patches and diffs (2026-11-14)

PR 5 of the file-format previews series. A `.patch` or `.diff` file (the daemon's
`text/x-diff`) opens as **Diff | Source**, with **Unified | Split** after the switch in Diff.
Frontend only; built on the registry (file-previews-1-registry.md).

## Files

| Path | What |
| --- | --- |
| `src/components/files/previews/patch.ts` | the model: commits, file sections, mail and log headers; pure, table tested |
| `src/components/files/previews/PatchBody.tsx` | the body: empty and not-a-diff states, the CodeView of sections |
| `src/components/files/previews/PatchRows.tsx` | the commit header, a mailbox's commit row, a file's sticky row |
| `src/components/files/previews/PatchControls.tsx` | Unified \| Split (the kind's `Controls`) |
| `src/components/files/previews/kinds/patch.tsx` | the kind, its meta |
| `mock/patches.ts` | fixtures under `docs/patches/` in the code-foundry checkout |
| `e2e/file-previews-patch.spec.ts` | the long-patch check and the SHOTS-gated screenshots |

Shared lines changed: `registry.test.ts` (rows for `.patch`/`.diff`), `FileTab.test.tsx` (one
test), `mock/files.ts` (the import and one spread line in `fixtures()`).

## Decisions

- **The library parses each file; we only split.** `parsePatch` splits the text into commits
  (`From <sha> …` from format-patch, `commit <sha>` from `git show` / `git log -p`) and each
  commit into file sections (at `diff --git`, else at a `---`/`+++` pair outside a hunk, moved up
  onto a `diff -ru …` line above it), then hands each section to @pierre/diffs `processFile`,
  as the PR Code tab's `parsePatchFiles` does. Ours too: the mail header (From, Date, Subject
  with RFC 2047 words decoded and `[PATCH n/m]` stripped, the body up to `---`), binary
  (`Binary files … differ`, `GIT binary patch`), copies, and a plain diff's status from
  `/dev/null` (the library calls two different names a rename; `diff -u` cannot say rename).
- **Forgiving what git apply forgives.** An empty line inside a hunk is context whose space an
  editor stripped, and after a file's last hunk ends by its counts the rest (format-patch's
  `-- ` and version, `Only in …`) is not the file's (`sectionText`). Without this a patch
  saved through an editor that trims trailing spaces flagged every file.
- **Malformed input shows what parses.** Each section is parsed with `throwOnError`; on a throw
  the error becomes the section's `problem` and it is parsed again leniently (the library
  repairs a cut hunk; it logs what it could not to the console). The row gets a warning mark
  (its tooltip says what), a notice on top counts them ("1 file did not parse whole…").
  Nothing that reads as a diff: "No diff in this file" with **Show source**. An empty file:
  "Empty patch". A read cut at 1 MiB: FileTab's truncated notice, and the last section is the
  one flagged.
- **One virtualized CodeView, as the PR Code tab.** Every section is an item of the library's
  `CodeView` with our own sticky header (`renderCustomHeader`), so a patch of a thousand files
  mounts the few in view. Its rows must all be one height (`itemMetrics.diffHeaderHeight`; it
  lays out from metrics, not the DOM), which shaped two things:
  - A single commit's subject, byline and message sit above the items (`renderCodeViewHeader`),
    scrolling with them.
  - In a mailbox of several commits, each commit is an item with an empty diff, always folded,
    whose header is a one-row `1/2 · subject · author · date · sha`. Its message is not shown.
  - A binary file, a mode-only change, an unchanged rename or an empty new file shows its
    one-line note in its row ("Binary file", "Mode 100644 → 100755") instead of under it.
- **Folding earns its place.** Clicking a file's row folds its diff (as the PR Code tab's
  chevron does; a chevron says it can). It is how one skips a lockfile in a long patch, and a
  section over 1,500 diff lines (`COLLAPSE_OVER`, the PR Code tab's) starts folded showing its
  line count. Rows with only a note have nothing to fold.
- **Open file is in.** A row's file icon opens the path in a File tab of the thread's checkout,
  after `statFile` says it is there ("Not in this checkout" toast otherwise). Only for a tab in
  a project, and not for a deleted file. The rest of the row folds; the icon stops the click.
- **Unified | Split and wrap** are the codeView store's `diffStyle` and `wrap`, shared with the
  Diff tab and the PR Code tab. `wrap: true` on the kind keeps the wrap toggle in Diff.
- **Meta** `2 files · +17 −1 · Patch`, the counts in the diff colours; `135 B · Patch` when there
  are no files. The kind's `meta` and the body read one parse: `patchModelOf` remembers the last
  four texts.
- **Show source** in the not-a-diff state is the registry's `onMode` (added by PR 4).

## Large patches

A 1 MiB patch (`docs/patches/big.patch`, 1,220 files, generated in `mock/patches.ts`) in the
drive (WebKit, dev build, mock daemon): `parsePatch` takes 17–21 ms; from `openFileInPanel` to
the meta line 154 ms (the read and the parse), to the first rows drawn 497 ms; jumping to the
bottom draws in 42 ms with 3 sections mounted. `e2e/file-previews-patch.spec.ts` asserts that
fewer than 20 rows are mounted at the top and at the bottom.

## Gotchas

- `processFile`'s `isGitDiff` default tests a global (`/g`) regex; pass it explicitly.
- The library logs a malformed section with `console.error` when it recovers; a test that feeds
  one silences it (`vi.spyOn(console, "error")`).
- A CodeView item's fold change needs a new `version` or the view keeps the old one.

## Follow-ups

- A mailbox's per-commit message (the row has one line; a taller row needs CodeView to lay out
  rows of more than one height).
- Open file could check the paths up front and show the icon only for those present.
