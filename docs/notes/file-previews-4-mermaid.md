# File previews 4: Mermaid (2026-11-14)

PR 4 of the file-format previews series. A `.mmd` / `.mermaid` file opens as Diagram | Source,
and a ```` ```mermaid ```` fence in a rendered markdown file (the File tab's MarkdownPreview)
becomes its diagram. One renderer serves both.

## Files

| Path | What |
| --- | --- |
| `src/components/mermaid/render.ts` | the only importer of `mermaid` (and DOMPurify): its own lazy chunk. Config, one render at a time, cleanup |
| `src/components/mermaid/sanitizeSvg.ts` | the last pass on the SVG before the DOM (own DOMPurify instance) and `inertCss` |
| `src/components/mermaid/mermaidTheme.ts` | app theme → Mermaid theme variables and CSS (pure) |
| `src/components/mermaid/useMermaid.ts` | `useMermaid(source)`: loads `render.ts`, re-renders on text or theme change, a 32-entry cache |
| `src/components/mermaid/DiagramSvg.tsx`, `mermaid.css` | puts the sanitized SVG in the page, sized to fit |
| `src/components/mermaid/MermaidFence.tsx` | the fence in markdown |
| `src/components/mermaid/diagramInfo.ts` | type from the text, the meta line, `isMermaidFence`, `messageSummary` (pure) |
| `src/components/files/previews/kinds/mermaid.ts`, `MermaidBody.tsx` | the kind and its body |
| `mock/mermaid.ts` | fixtures under `docs/`: architecture, sequence, broken, hostile, wide, empty `.mmd`, `diagrams.md` |
| `e2e/file-previews-mermaid.spec.ts` | real rendering in WebKit, plus the SHOTS screenshots |

## Decisions

- **mermaid 12.3.0, pinned, loaded lazily.** Only `render.ts` imports it, and only
  `useMermaid` imports `render.ts` (a dynamic `import()`), so the main entry chunk did not
  change (494,922 → 494,910 B). Nothing loads until a diagram is on screen; a markdown file with
  no mermaid fence never loads it. The embedded frontend grows by 5.2 MB raw (+1.5 MB gzipped
  JS) over about 90 chunks: Mermaid splits its diagram types, so a flowchart fetches the
  renderer chunk (88 KB), the flowchart and dagre chunks and the shared core. 1.5 MB of the 5.2
  is ELK, fetched only by a diagram that asks for `layout: elk`. Licences: MIT, ISC, BSD,
  Apache-2.0, Unlicense; DOMPurify MPL-2.0 OR Apache-2.0; elkjs EPL-2.0 OR GPL-3.0-or-later.
  `dompurify` is now a direct dependency, pinned to the 3.4.17 Mermaid already brought (one copy).
- **Security.** The diagram text is untrusted. `securityLevel: "strict"`, `htmlLabels: false`
  (labels are SVG text), `suppressErrorRendering: true`. `secure` (keys a diagram's
  `%%{init}%%` or front matter cannot change) gains `htmlLabels`, `arrowMarkerAbsolute` and
  `dompurifyConfig` on top of Mermaid's own. No `bindFunctions` is ever called, so no click
  handler runs. Then `sanitizeSvg`, whatever Mermaid let through: SVG, SVG filters and the HTML a
  foreignObject may carry; scripts, images, frames, form controls and every `on*` attribute go;
  an `href`/`xlink:href` stays only when it points inside the diagram (`#marker`); `url()` that
  leaves the diagram, `image-set()` and `@import` in a `<style>` or style attribute are made
  inert (backslashes go first, so an escaped `\75 rl(` cannot spell `url(`). It runs on a
  DOMPurify instance of its own: Mermaid adds hooks to the module's default instance.
- **Rendered off screen, nothing left behind.** Mermaid measures text with `getBBox`, so it
  draws in the document: in a box of ours at `left:-100000px`, removed in `finally` with
  Mermaid's temporary `#d<id>` / `#i<id>` elements. Renders are queued: the configuration is
  global and each render sets its theme. The e2e spec checks nothing stays in the body.
- **Theme.** `theme: "base"` with variables from the slots: a node is `--cf-surface-sunken`
  with a `--cf-border-strong` border, text `--cf-text`, edges and arrowheads `--cf-text-muted`,
  an edge label on `--cf-surface`; series (pie, git, mindmap) cycle `--cf-chart-1..6`. All
  opaque `#rrggbb` (Mermaid mixes colours with khroma). A little CSS on top: 1.25px edges, 6px
  corners, edge labels 11px muted on an opaque patch. The font is the app's body stack at 13px,
  set for every diagram type that has its own (sequence: actor, note, message fonts). The
  render is keyed by the theme's variables, so a theme change (dark/light, a user theme
  edited) draws again; the old diagram stays until the new one is ready.
- **Layout** is dagre (GitHub's curved look), with tighter spacing than Mermaid's defaults so
  a diagram fits a side pane at its natural size more often. A diagram can still ask for ELK.
- **Sizing.** The SVG takes the width it is given, at most its natural width (viewBox), at
  least 60% of it; past that the container scrolls (a tall diagram scrolls down). Centred both
  ways in the File tab. `text-rendering: geometricPrecision`: without it WebKit lays the system
  font out at the shrunk size, where its tracking is wider than Mermaid measured, and labels
  run out of their boxes. Each view renames the cached SVG's id (CSS and marker ids hang off
  it) so two views of one render never share marker ids.
- **Errors.** A file: "This diagram cannot be drawn", the parser's whole message in a code box,
  and Show source. An empty file and one over Mermaid's 50K-character `maxTextSize` say so
  without loading Mermaid (past the limit Mermaid would draw a notice as if it were the
  diagram). A fence: stays the code block, with "Diagram not drawn: <first line of the message,
  plus its last when the first only introduces it>" under it, the whole message on hover. The
  library failing to load is an error too, not cached, so the next mount tries again.
- **`onMode` on the body (registry change).** The body could not change the mode, and Show
  source needs to. `PreviewBodyProps.onMode` does what the switch does (it is the same
  function in FileTab), so the choice is remembered for the kind like a click on Source.
- **Meta.** `Flowchart · 9 nodes · 313 B · Mermaid`. The type comes from the first keyword of
  the text (after front matter, comments and directives), so it shows before the render. The
  node count is the rendered SVG's `g.node` groups, for flowcharts only, where that is exactly
  the diagram's nodes (clusters are `g.cluster`). Other types have no count: for a sequence
  diagram "nodes" means nothing, and counting other types' parts from the text is neither
  cheap nor reliably correct.
- **Copy contents** copies the source (the registry's default) and **Edit** switches to
  Source (the registry's default). Source is highlighted as Mermaid by the code view's
  library, which already maps `.mmd` and `.mermaid`.
- **Where fences become diagrams.** The File tab's rendered markdown only. Left out:
  - *Thread messages.* Streaming alone could be made safe (the last block is still a code
    block until the stream ends, StreamingMarkdown's `streaming` flag; the cache makes the
    switch to the whole answer instant). What is not safe: thread find counts matches from the
    data as rendered (lib/markdownText mirrors the thread's renderers), so a fence's code would
    count matches that no longer exist on screen; and a row whose height changes after an
    async render, in a virtualized timeline that holds its tail, needs its own look. Both are
    a follow-up of their own.
  - *Pull request bodies and comments.* GitHub draws mermaid fences there too; the PR surface
    passes no `code` renderer today, so it is a separate change.
  - *Plugin MarkdownNode* and the agent search's answer (inert by design).

## Tests

- vitest: `diagramInfo.test.ts` (types, meta, fence decision, message summary),
  `mermaidTheme.test.ts` (variables from the slots, every catalog theme opaque, CSS),
  `sanitizeSvg.test.ts` (script, `on*`, `javascript:`/`data:`/remote links, an HTML label with
  `<img onerror>` and an iframe, remote CSS), `MermaidBody.test.tsx` (drawing, own ids, Mermaid's
  sizing replaced, meta, error and Show source, empty and over-limit without loading Mermaid,
  a load failure retried, one render per text and theme and a new one on a theme change),
  `MermaidFence.test.tsx` (code block until drawn, the note on an error, no load without a
  fence). `render.ts` is mocked: jsdom cannot lay out SVG text, so Mermaid does not run there.
- e2e (WebKit): a file and a fence drawn at a real size within the pane, SVG text in the app
  font; the hostile fixture drawn with no script, image, foreignObject, handler or outside
  link left and nothing run on a click; the wide fixture scrolling sideways at no less than
  60%; the broken fixture's message and Show source; nothing left in the body.

## Gotchas

- Keep `suppressErrorRendering` on (and in `secure`): off, a parse error comes back as Mermaid's
  bomb graphic drawn as if it were the diagram, and a draw error leaves it in the SVG.
- Mermaid's sequence "Note over A,B" is as wide as the two actors, whatever its text: a long
  note runs past its box. That is Mermaid's layout (GitHub's too), not the font.
- The mock daemon does not reload `mock/*.ts`: restart `make drive` after changing a fixture.
