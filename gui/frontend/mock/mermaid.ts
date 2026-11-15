/**
 * The Mermaid previews' fixtures (docs/notes/file-previews-4-mermaid.md), under the
 * code-foundry checkout's docs/ (mock/files.ts `fixtures()`): a flowchart, a sequence
 * diagram, one that does not parse, one written to attack the page, and a markdown file
 * with a ```mermaid fence.
 */

export const ARCHITECTURE_MMD = `flowchart TD
  gui["GUI · Wails + React"] -->|Connect-Web| daemon
  cli[CLI] -->|Connect| daemon
  daemon[Daemon] --> threads[Thread store]
  daemon --> projects[Project store]
  daemon --> terms[Terminal store]
  threads --> claude([Claude Code])
  projects --> git([git · gh])
  terms --> vt([libghostty-vt])
`;

export const SEQUENCE_MMD = `sequenceDiagram
  participant GUI
  participant Daemon
  participant Claude as Claude Code
  GUI->>Daemon: SendPrompt(thread, text)
  Daemon->>Claude: stream-json turn
  activate Claude
  Claude-->>Daemon: assistant deltas
  Daemon-->>GUI: WatchThread items
  Claude-->>Daemon: result
  deactivate Claude
  Note over GUI,Daemon: the thread view re-renders from the snapshot
  Daemon-->>GUI: turn settled
`;

/** Line 3 has two arrows in a row. */
export const BROKEN_MMD = `flowchart LR
  a[Start] --> b[Parse]
  b --> --> c[End]
`;

/** Everything a diagram might try: script in a label, an HTML label, a javascript: link, a click handler, a remote stylesheet. */
export const HOSTILE_MMD = `%%{init: {"htmlLabels": true, "securityLevel": "loose", "themeCSS": ".node{background:url(https://example.invalid/x.png)}"}}%%
flowchart LR
  a["<script>window.__cfPwned=1</script>Script"] --> b["<img src=x onerror='window.__cfPwned=2'>Image"]
  b --> c["<b onclick='window.__cfPwned=3'>Bold</b>"]
  c --> d[Link]
  click d "javascript:window.__cfPwned=4"
  click a call window.alert()
`;

export const DIAGRAMS_MD = `# code-foundry

Run fleets of **Claude Code** threads across git worktrees, from one window.

## How it fits together

The GUI and the CLI are both clients of one daemon. Stores own the processes and publish
snapshots; nothing else holds state.

\`\`\`mermaid
${ARCHITECTURE_MMD}\`\`\`

## A diagram that does not parse

\`\`\`mermaid
${BROKEN_MMD}\`\`\`

## Build

\`\`\`sh
make build
make check
\`\`\`
`;

/** The fixtures by path under the checkout, with the mime the daemon reports (internal/fsx: `.mmd` is text/vnd.mermaid). */
export const MERMAID_FILES: Readonly<Record<string, { text: string; mime: string }>> = {
  "docs/architecture.mmd": { text: ARCHITECTURE_MMD, mime: "text/vnd.mermaid" },
  "docs/sequence.mmd": { text: SEQUENCE_MMD, mime: "text/vnd.mermaid" },
  "docs/broken.mmd": { text: BROKEN_MMD, mime: "text/vnd.mermaid" },
  "docs/hostile.mmd": { text: HOSTILE_MMD, mime: "text/vnd.mermaid" },
  "docs/empty.mmd": { text: "", mime: "text/vnd.mermaid" },
  "docs/diagrams.md": { text: DIAGRAMS_MD, mime: "text/markdown" },
};
