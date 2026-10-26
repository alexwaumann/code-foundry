/**
 * /cf/jsx.js (docs/notes/page-library.md): a page's React in TSX with no build step.
 *
 *   <script src="/cf/jsx.js"></script>
 *   <script type="text/tsx"> import { Button } from "@cf/ui"; … </script>
 *
 * A classic script, so it runs before any module loads: it installs the import map
 * (react, react-dom, react-dom/client, react/jsx-runtime, @cf/ui, @cf/icons) unless the page
 * has one, then, once the document is parsed, transforms every text/tsx, text/jsx and
 * text/babel script (inline, or src= fetched) with Sucrase (jsx with the automatic runtime,
 * typescript) and runs each as a module, in document order, each waiting for the last.
 * A transform, import or evaluation error, and any uncaught error after, shows in a box
 * in the page and in the console: a page never fails blank. <html data-cf-jsx> is
 * "running", then "ready" or "error".
 */
import { transform } from "sucrase";
import { absolutize, locate, scriptLine, tagMismatch } from "./source";

/** The script types the loader runs. */
const TYPES = ["text/tsx", "text/jsx", "text/babel"];

/** The import map's specifiers and the files they name, beside this script. */
const IMPORTS: Record<string, string> = {
  react: "react.js",
  "react-dom": "react-dom.js",
  "react-dom/client": "react-dom-client.js",
  "react/jsx-runtime": "jsx-runtime.js",
  "@cf/ui": "ui.js",
  "@cf/icons": "icons.js",
};

const self = document.currentScript instanceof HTMLScriptElement ? document.currentScript.src : "";
const base = new URL("./", self || new URL("/cf/jsx.js", location.href).href).href;
const root = document.documentElement;

function installImportMap(): void {
  if (document.querySelector('script[type="importmap"]')) {
    console.warn("cf/jsx: the page has its own import map; it must map " + Object.keys(IMPORTS).join(", ") + " itself");
    return;
  }
  const map = document.createElement("script");
  map.type = "importmap";
  map.textContent = JSON.stringify({ imports: Object.fromEntries(Object.entries(IMPORTS).map(([k, f]) => [k, base + f])) });
  // Typed as always there, but a script in <head> runs before <body> exists.
  ((document.head as HTMLHeadElement | null) ?? root).prepend(map);
}

let box: HTMLElement | null = null;

/**
 * Shows an error in the page and logs it: one box at the top of the body, in the flow, so
 * the card grows to show it (a fixed box would sit outside a short card), newest last. In
 * the theme's error colours; a page without /cf/theme.css (a mockup) gets the system's.
 */
function report(title: string, detail: string, err?: unknown): void {
  console.error("cf/jsx: " + title + "\n" + detail, err ?? "");
  if (!box) {
    box = document.createElement("div");
    box.setAttribute("data-cf-jsx-error", "");
    box.setAttribute("role", "alert");
    box.style.cssText =
      "position:relative;z-index:2147483647;margin:8px;padding:10px 12px;overflow:auto;" +
      "border:1px solid var(--cf-error,CanvasText);border-radius:6px;background:var(--cf-error-surface,Canvas);" +
      "color:var(--cf-error-text,CanvasText);font:12px/1.45 ui-monospace,'SF Mono',Menlo,monospace;white-space:pre-wrap";
    ((document.body as HTMLElement | null) ?? root).prepend(box);
  }
  const entry = document.createElement("div");
  const head = document.createElement("strong");
  head.textContent = title;
  entry.append(head, document.createTextNode("\n" + detail));
  if (box.childNodes.length > 0) entry.style.marginTop = "8px";
  box.appendChild(entry);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The page's file name, as errors and stack frames name an inline script. */
const pageFile = decodeURIComponent(location.pathname.split("/").pop() || "") || "page.html";

/** The page's own HTML, fetched once, to number an inline script's lines as the file does. */
let pageHtml: Promise<string> | null = null;
function ownHtml(): Promise<string> {
  pageHtml ??= fetch(location.href)
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");
  return pageHtml;
}

/** Where the last inline script was found in the page's HTML: the next is searched after it. */
let htmlAt = 0;

/** Blob module URLs, by the name a stack frame should show instead (WebKit ignores sourceURL there). */
const blobNames = new Map<string, string>();

/** An error's message and stack (WebKit's stack has no message line), blob URLs named. */
function detail(err: Error): string {
  const stack = err.stack ?? "";
  let out = stack.includes(err.message) ? stack : err.message + (stack ? "\n" + stack : "");
  for (const [url, name] of blobNames) out = out.split(url).join(name);
  return out;
}

/** The scripts to run, in document order. */
function pageScripts(): HTMLScriptElement[] {
  return [...document.querySelectorAll<HTMLScriptElement>("script[type]")].filter((s) => TYPES.includes(s.type.trim().toLowerCase()));
}

async function run(script: HTMLScriptElement, n: number): Promise<boolean> {
  const src = script.getAttribute("src");
  let source = script.textContent;
  // An inline script's first line in the file: errors, frames and stacks say page.html:18,
  // not line 6 of the script. 0 when the page's HTML cannot be read (then "script 2").
  let first = 1;
  if (!src) {
    const at = scriptLine(await ownHtml(), source, htmlAt);
    first = at.line;
    htmlAt = at.end;
  }
  const name = src ? new URL(src, document.baseURI).href : first ? pageFile : `${pageFile} script ${String(n)}`;
  if (src) {
    try {
      const res = await fetch(name);
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      source = await res.text();
    } catch (err) {
      report(`Could not load ${src}`, message(err), err);
      return false;
    }
  }
  let code: string;
  const where = (msg: string) => locate(source, msg, first || 1);
  // Sucrase compiles a closing tag that names another element (`<b>…</div>`) without a word,
  // or fails much further down: say which tag it is first.
  const mismatch = tagMismatch(source, first || 1);
  if (mismatch) {
    const at = where(mismatch);
    report(`Syntax error in ${name}`, at.message + at.frame);
    return false;
  }
  try {
    code = transform(source, {
      transforms: ["jsx", "typescript"],
      jsxRuntime: "automatic",
      production: true,
      disableESTransforms: true,
      filePath: name,
    }).code;
  } catch (err) {
    const at = where(message(err).replace(/^Error transforming .*?: /, ""));
    report(`Syntax error in ${name}`, at.message + at.frame, err);
    return false;
  }
  // Sucrase keeps line numbers, so blank lines before the code make the module's lines the
  // file's: a stack frame reads page.html:18 (sourceURL, and blobNames for WebKit).
  const padded = "\n".repeat(Math.max(0, first - 1)) + absolutize(code, src ? name : document.baseURI);
  const url = URL.createObjectURL(new Blob([padded + `\n//# sourceURL=${name.replace(/\s/g, "-")}\n`], { type: "text/javascript" }));
  blobNames.set(url, name.replace(/\s/g, "-"));
  try {
    await import(/* @vite-ignore */ url);
    return true;
  } catch (err) {
    const what = err instanceof SyntaxError || /import|module|specifier|export/i.test(message(err)) ? "Could not import in" : "Error in";
    report(`${what} ${name}`, err instanceof Error && !(err instanceof SyntaxError) ? detail(err) : message(err), err);
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function runAll(): Promise<void> {
  root.dataset.cfJsx = "running";
  let ok = true;
  const scripts = pageScripts();
  for (const [i, s] of scripts.entries()) {
    ok = (await run(s, i + 1)) && ok;
  }
  root.dataset.cfJsx = ok ? "ready" : "error";
}

/** Uncaught errors (a render that throws, a rejected promise) once the page's code runs. */
function watchErrors(): void {
  window.addEventListener("error", (e) => {
    if (e.message.startsWith("ResizeObserver loop")) return;
    report("Uncaught error", e.error instanceof Error ? detail(e.error) : e.message, e.error);
  });
  window.addEventListener("unhandledrejection", (e) => {
    report("Unhandled rejection", e.reason instanceof Error ? detail(e.reason) : String(e.reason), e.reason);
  });
}

if (!(window as { __cfJsx?: boolean }).__cfJsx) {
  (window as { __cfJsx?: boolean }).__cfJsx = true;
  installImportMap();
  watchErrors();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void runAll(), { once: true });
  else void runAll();
}
