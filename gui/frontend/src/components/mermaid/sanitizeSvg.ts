/**
 * The last word on a diagram's SVG before it goes into the document. The diagram's text is
 * untrusted (an agent or a cloned repository wrote it): Mermaid renders it at its strict
 * security level and sanitizes what it serializes, and this pass holds the line whatever
 * Mermaid lets through, now or in a later version. Only in the lazily loaded renderer's
 * chunk (render.ts), with Mermaid.
 *
 * - SVG and SVG filters only, plus the HTML a `<foreignObject>` label may carry (DOMPurify
 *   drops scripts, event handlers and anything that loads or runs inside it too).
 * - No `<a>` survives as a link: an href or xlink:href is kept only when it points inside
 *   the diagram (`#marker`), so no javascript:, data: or remote URL is left to follow.
 * - Styles reach nothing outside the diagram: `url(...)` in a `<style>` or a style
 *   attribute keeps only `#fragment` targets, and `@import` goes.
 */
import DOMPurify from "dompurify";

/** A URL that stays inside the diagram (a marker, a gradient, a clip path). */
function isFragment(url: string): boolean {
  return /^\s*#/.test(url);
}

/**
 * CSS with every url() that leaves the diagram made inert, and no @import or image-set().
 * Backslashes go first: a CSS escape can spell a function's name (`\75 rl(`), and
 * Mermaid's own CSS has none.
 */
export function inertCss(css: string): string {
  return css
    .replace(/\\/g, "")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/(?:-webkit-)?image-set\(/gi, "none(")
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, _q: string, u: string) => (isFragment(u) ? m : "none"))
    .replace(/url\(\s*(?!['"]?\s*#)/gi, "none(");
}

let own: ReturnType<typeof DOMPurify> | null = null;

/**
 * An instance of our own: the module's default one is Mermaid's too (the same package), and
 * Mermaid adds hooks of its own to it; these must neither run in Mermaid's passes nor be
 * changed by Mermaid's.
 */
function purifier(): ReturnType<typeof DOMPurify> {
  if (own) return own;
  const p = DOMPurify(window);
  p.addHook("uponSanitizeAttribute", (_node, data) => {
    const name = data.attrName.toLowerCase();
    if ((name === "href" || name === "xlink:href") && !isFragment(data.attrValue)) data.keepAttr = false;
    else if (name === "style") data.attrValue = inertCss(data.attrValue);
  });
  p.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style" && node.textContent) node.textContent = inertCss(node.textContent);
  });
  own = p;
  return p;
}

/** The SVG Mermaid rendered, safe to set as a container's innerHTML. */
export function sanitizeSvg(svg: string): string {
  return purifier().sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    // Mermaid's own additions to the profile: its labels and its stylesheet.
    ADD_TAGS: ["foreignobject", "style"],
    ADD_ATTR: ["dominant-baseline"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "img", "image", "video", "audio", "link", "meta", "base"],
    FORBID_ATTR: ["onclick", "onload", "onerror", "onmouseover", "formaction", "action", "target"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  });
}
