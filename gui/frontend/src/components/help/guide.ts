/**
 * The getting started guide the help overlay's Guide tab shows: docs/GETTING-STARTED.md,
 * bundled at build time (a Vite ?raw import of the repo file), so the in-app guide and
 * the repo's cannot drift. vite.config.ts lets the dev server read docs/.
 */
import source from "../../../../../docs/GETTING-STARTED.md?raw";

/** One table-of-contents entry: an h2 or h3 of the guide, in document order. */
export interface TocEntry {
  level: 2 | 3;
  title: string;
}

/**
 * What the overlay renders: the guide from its first h2 on. The file's title (h1) and a
 * maintainer comment above it are for readers of the repo; the overlay has its own tab.
 */
export function guideBody(markdown: string): string {
  const at = markdown.search(/^## /m);
  return at < 0 ? markdown : markdown.slice(at);
}

/** Inline markdown a heading may carry, removed for the contents list: emphasis, code and links. */
function plainHeading(text: string): string {
  return text
    .replace(/\s+#+\s*$/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .trim();
}

/**
 * The h2 and h3 ATX headings of a markdown document, in order, skipping fenced code
 * blocks and HTML comments. The overlay scrolls to entry i by finding the i-th h2/h3
 * the renderer produced, so this must see exactly the headings the renderer does.
 */
export function buildToc(markdown: string): TocEntry[] {
  const toc: TocEntry[] = [];
  let fence: string | null = null;
  let comment = false;
  for (const line of markdown.split("\n")) {
    if (comment) {
      if (line.includes("-->")) comment = false;
      continue;
    }
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      const marker = f[1] ?? "";
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (/^ {0,3}<!--/.test(line) && !line.includes("-->")) {
      comment = true;
      continue;
    }
    const h = /^ {0,3}(#{2,3})[ \t]+(.+)$/.exec(line);
    if (!h) continue;
    const title = plainHeading(h[2] ?? "");
    if (title) toc.push({ level: h[1] === "##" ? 2 : 3, title });
  }
  return toc;
}

/** The guide as the overlay shows it. */
export const guideMarkdown = guideBody(source);

/** Its contents, built once. */
export const guideToc = buildToc(guideMarkdown);
