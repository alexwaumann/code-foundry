# File viewer 4: path chips

PR 4 of 5 of the file viewer (1: daemon RPCs, 2: code and diff rendering, 3: File and Diff
tabs, 4: this, 5: PR Code tab). Frontend only. File paths in Claude's markdown and in file
tool rows become chips that open the File tab in the side panel
(`openFileInPanel("current", target)`).

## Files

| Path | What |
| --- | --- |
| `src/lib/pathChips.ts` (+ test) | `matchPath(token, "code" \| "prose")`, `splitProse`, `chipTarget`, `rehypePathChips`; the rules in the header |
| `src/components/thread/PathChip.tsx` | `PathChip` (style A) and `ToolPathChip` (the row label's quiet variant) |
| `src/components/thread/context.ts` | `PathPlaceContext`: where chips resolve when not the thread's |
| `src/components/pr/Markdown.tsx` | `MarkdownExtras.pathChip`: inline `code` and marked prose spans render as chips; the rehype pass is appended after sanitize |
| `src/components/thread/Code.tsx` | `threadExtras.pathChip` |
| `src/components/files/MarkdownPreview.tsx` (+ test) | the same chips, resolving against the tab's `base` |
| `src/lib/toolSummary.ts` | `toolFileTarget`, `firstPatchLine` |
| `src/components/thread/rows.tsx` | `ToolLabel` wraps a file tool's name + directory in `ToolPathChip` |
| `src/lib/NavRow.tsx`, `overview/WorktreeOverview.tsx` | `tipWhenTruncated`: a Changes row's tooltip only when its path is cut short (always for a rename) |
| `mock/thread.ts`, `e2e/path-chips.spec.ts` | the idle thread's last answer names `README.md` and `` `src/app.ts:12` ``; 2 tests |

## Detection

Two places, two strictnesses:

- **Inline code** (`` `src/a.ts:12` ``): the whole span, trimmed. Generous: the author marked it.
- **Prose**: whitespace-separated words of text nodes outside `code`, `pre`, `a`, `kbd`, with
  leading `([{"'` and trailing `.,;:!?)]}"'` shed. Strict.

A token is one path with no whitespace, optionally `:line`, `:line:col` or `:line-line`.
Rejected: `://` anywhere, a domain-looking first segment (`github.com/a/b`), a leading `-`,
`@` or `$`, any of `*?[]{}()<>|&;=,$`'"\#` (globs, shell, anchors), no letter (`1/2`,
dates), `/`, `~`, `~/`, `.`, `..`, a `...` segment (Go's `./...`), line 0.

Then it must look like a path:

| | code | prose |
| --- | --- | --- |
| absolute | 2+ segments or a known extension (`/compact` is a slash command) | same |
| `~/`, `./`, `../` | yes | yes |
| known extension or name (`README.md`, `Makefile`, `.gitignore`) | yes | yes |
| trailing slash | yes (a folder: the File tab says "This is a folder") | 2+ segments |
| relative, no extension | has a `/`, unless `origin/…`, `cf/…`-style refs or a MIME type | 3+ segments |

Bare names also skip `Node.js`-style names (capitalized stem + `.js`). `EXTENSIONS` is a
curated list (code, config, prose, media, archives), not `grammarFor`: that accepts language
names and hljs aliases (`.r`, `.m`, `.log` via `console.log`) that read as members in prose.

**False-positive policy**: fewer in prose, more generous in code. A miss costs nothing (the
text stays); a wrong chip opens "File not found". So prose needs a strong signal (extension,
3+ segments, a prefix), and `and/or`, `client/server`, `internal/store` stay text there.
Spaces in paths are never detected.

## Resolution

`chipTarget(match, place)`: absolute and `~/` paths as typed (the daemon expands `~`),
relative ones against `place.base` via `resolvePath`. Existence is not checked: the File tab
shows its not-found and folder states.

- Thread: `ThreadContext.cwd` (the thread's `worktreePath`; a no-project thread's is `$HOME`,
  the daemon's `o.Home`) and the thread's `projectId` from the threads store.
- File tab markdown: `PathPlaceContext` with the tab's `project` and `base` (the checkout the
  tab came from), not the file's own folder (agreed decision). A `docs/x.md` linking
  `src/y.ts` therefore means the repo's `src/y.ts`.

## Rendering

- `PathChip`: `tagClass(false, TAG_ACCENT.file)` (the user bubble's file tag) plus a
  `FileText` icon, mono, `font-normal`; the directory truncates from its start (rtl box with
  a `<bdi>`, not LRM marks: those would end up in copied text), the name stays, the suffix
  muted. `select-text` overrides the tag's `select-none` so copying a paragraph keeps its
  paths. Tooltip (`Tip whenTruncated`) with the whole token only while cut short.
- Interaction: a `span role="button" tabIndex=0`; click (cmd-click is the same), Enter and
  Space open; the event stops at the chip. A span because tool rows are `<button>`s and a
  button cannot nest in one.
- Markdown: `withExtras` overrides `code` (inline only: no language class, no newline;
  fenced blocks never reach it on surfaces that set `code`) and `span` (only spans the pass
  marked with `dataCfPath`, re-matched on render). `rehypePathChips` runs after sanitize and
  skips text nodes without `/` or `.`; Markdown is memoized on its text, so a streaming row
  re-runs it once per delta like the rest of the pipeline.
- **Tool rows** (Read, Edit, MultiEdit, Write, NotebookEdit): the name + directory part of
  the label is a `ToolPathChip`: quiet at rest (the row's own bold name and muted dir), the
  tag's border and tint on hover, focusable. A full tag in every row was too loud for the
  dense log. Opens at a Read's `offset`, an edit's first changed line (`firstPatchLine` over
  the result's `structuredPatch`: the new-file line of the first `+`/`-`), else the top. The
  rest of the row still expands and collapses. The row button's accessible name includes the
  chip's `aria-label` ("Open routes.ts").
- Not chipped: user bubbles (they have tags), fenced code, links, Grep/Glob result lists,
  group rows' file-name meta.

## Verified

- `make check` green.
- Playwright on the mock daemon: `path-chips.spec.ts` (WebKit + Chromium); `thread`,
  `file-tabs`, `worktree-panel`, `code-block-actions` specs on both.
- Live (`make gui-build`, `CODE_FOUNDRY_HOME=/tmp/cf-fv4/home`, scratch repo
  `~/cf-scratch-fv4`, a Haiku 5.5 / medium thread asked to read four files, add a route and
  describe the repo), dark and light: the answer's inline-code and prose chips (including
  `package.json` in prose and the absolute README path, truncated from its start, with its
  tooltip); `src/server/routes.ts:6` opening `routes.ts` with line 6 marked; the second
  Edit row's path (hover tint) moving that tab's mark to line 10, its first change, with the
  row still collapsed; `docs/usage.md` rendered with chips, whose prose `src/server/routes.ts`
  found the open `routes.ts` tab (resolved against the checkout, not `docs/`). The tool
  row's hover box was narrowed by 2px after the screenshots (its border touched the verb).

## Left out

- Grep/Glob result paths (their detail is a text block; a chip per line is a separate change).
- GitHub-style `#L12` suffixes and paths with spaces.
