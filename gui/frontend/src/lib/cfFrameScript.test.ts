import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SRC from "../../../../internal/preview/frame.js?raw";
import { pageOpenUrl, pageUnsupported } from "@/components/files/previewGrant";

/*
 * The script the daemon writes into every document a page frame loads (internal/preview/
 * frame.js), run against a document of jsdom's with a parent that records what the page
 * posts: the page side of docs/notes/page-frame-links.md.
 */

interface Msg {
  type: string;
  url?: string;
  what?: string;
  text?: string;
}

/** jsdom's own host: a relative link in the test document resolves to it. */
const HOST = window.location.host;

/** The listeners a load added to the shared document, removed after each test. */
const added: [string, EventListener, boolean | undefined][] = [];

/** What an opaque origin has of storage: every use throws, as WebKit's does in a sandbox without allow-same-origin. */
function opaqueStorage() {
  const insecure = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  const proto = { userActivation: null };
  Object.defineProperty(proto, "serviceWorker", { configurable: true, get: insecure });
  return {
    win: {
      get localStorage(): unknown {
        return insecure();
      },
      get sessionStorage(): unknown {
        return insecure();
      },
      indexedDB: { open: insecure, deleteDatabase: insecure },
      caches: {},
    },
    navigator: Object.create(proto) as object,
  };
}

function load(opts: { at?: string; embedded?: boolean; navigation?: object; nested?: boolean; opaque?: boolean; resources?: string[]; observe?: (cb: () => void) => void } = {}) {
  const posted: Msg[] = [];
  /** What the script says of the document (cf:here, cf:going), apart from the rest. */
  const notes: string[] = [];
  let trusted = true;
  let went: string | null = null;
  /** The source a message event shows the script. */
  let source: unknown = null;
  const win: Record<string, unknown> = {
    // Events are dispatched untrusted in jsdom: the listener sees them as `trusted` says.
    addEventListener: (type: string, fn: (e: Event) => void, capture?: boolean) => {
      const seen: EventListener = (e) => {
        fn(
          new Proxy(e, {
            get: (t, k) => {
              if (k === "isTrusted") return trusted;
              if (k === "source") return source;
              const v = Reflect.get(t, k) as unknown;
              return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
            },
          }),
        );
      };
      added.push([type, seen, capture]);
      document.addEventListener(type, seen, capture);
    },
  };
  const opaque = opts.opaque ? opaqueStorage() : null;
  if (opaque) Object.defineProperties(win, Object.getOwnPropertyDescriptors(opaque.win));
  const resources = opts.resources ?? [];
  win.performance = { getEntriesByType: (t: string) => (t === "resource" ? resources.map((name) => ({ name })) : []) };
  if (opts.observe) {
    const observe = opts.observe;
    win.PerformanceObserver = class {
      constructor(cb: () => void) {
        observe(() => {
          cb();
        });
      }
      observe() {}
    };
  }
  let reloads = 0;
  const parent =
    opts.embedded === false
      ? win
      : {
          postMessage: (m: Msg) => {
            if (m.type === "cf:here" || m.type === "cf:going") notes.push(m.type);
            else posted.push(structuredClone(m));
          },
        };
  win.parent = parent;
  // The app's window is the top one; a frame inside the page has the page between.
  win.top = opts.nested ? {} : parent;
  /** The page's own frames' windows (window.frames). */
  const frames: unknown[] = [];
  win.frames = frames;
  win.name = "";
  /** What reached the browser's own window.open (a frame of the page by its name). */
  const opened: unknown[][] = [];
  win.open = (...args: unknown[]) => {
    opened.push(args);
    return null;
  };
  if (opts.navigation) win.navigation = opts.navigation;
  const at = new URL(opts.at ?? `http://${HOST}/preview/g/page.html`);
  // The document's own scroll: a viewport over a document that can be scrolled up to `max`.
  const scroll = { x: 0, y: 0, max: 0, frames: [] as (() => void)[], grown: [] as (() => void)[] };
  Object.defineProperties(win, {
    scrollX: { get: () => scroll.x },
    scrollY: { get: () => scroll.y },
  });
  win.scrollTo = (a: number | { left?: number; top?: number }, b?: number) => {
    const o = typeof a === "number" ? { left: a, top: b ?? 0 } : a;
    scroll.x = 0;
    scroll.y = Math.max(0, Math.min(scroll.max, o.top ?? 0));
  };
  win.requestAnimationFrame = (fn: () => void) => {
    scroll.frames.push(fn);
    return scroll.frames.length;
  };
  win.ResizeObserver = class {
    constructor(cb: () => void) {
      scroll.grown.push(cb);
    }
    observe() {}
    disconnect() {}
  };
  const location = {
    host: at.host,
    pathname: at.pathname,
    hash: at.hash,
    get href() {
      return at.href;
    },
    set href(v: string) {
      went = v;
    },
    reload: () => {
      reloads++;
    },
  };
  // The script under test, as the daemon inlines it, with these globals.
  // oxlint-disable-next-line typescript/no-implied-eval
  const run = new Function("window", "document", "location", "navigator", SRC) as (...globals: unknown[]) => void;
  const nav = opaque?.navigator ?? { userActivation: null };
  run(win, document, location, nav);
  const link = (attrs: Record<string, string>, connected = true) => {
    const a = document.createElement("a");
    for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
    a.textContent = "link";
    if (connected) document.body.append(a);
    return a;
  };
  const click = (el: HTMLElement, by: "user" | "script" = "user") => {
    trusted = by === "user";
    const e = new MouseEvent("click", { bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const press = () => {
    trusted = true;
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  };
  const form = (attrs: Record<string, string>, fields: Record<string, string> = {}) => {
    const f = document.createElement("form");
    for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v);
    for (const [k, v] of Object.entries(fields)) {
      const i = document.createElement("input");
      i.name = k;
      i.value = v;
      f.append(i);
    }
    document.body.append(f);
    return f;
  };
  const submit = (f: HTMLFormElement, by: "user" | "script" = "user", submitter?: HTMLElement) => {
    trusted = by === "user";
    const e = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: submitter ?? null });
    f.dispatchEvent(e);
    return e.defaultPrevented;
  };
  /** A message to the document, from its parent unless `from` says otherwise. */
  const message = (data: unknown, from: unknown = parent) => {
    source = from;
    document.dispatchEvent(new MessageEvent("message", { data }));
  };
  /** A frame of the page named name, as its window shows it (a window's own `window` is itself). */
  const frame = (name: string) => {
    const w: Record<string, unknown> = {};
    w.window = w;
    win[name] = w;
    return w;
  };
  const scroller = {
    /** Scrolled to y, as the page or the user would, and the scroll event that follows. */
    to: (y: number) => {
      scroll.y = Math.max(0, Math.min(scroll.max, y));
      document.dispatchEvent(new Event("scroll"));
    },
    /** The document grew (or shrank) to scroll up to max: the browser clamps, and resize observers hear it. */
    grow: (max: number) => {
      scroll.max = max;
      scroll.y = Math.min(scroll.y, max);
      for (const cb of scroll.grown) cb();
    },
    /** Runs the animation frames asked for so far. */
    frame: () => {
      for (const fn of scroll.frames.splice(0)) fn();
    },
    y: () => scroll.y,
  };
  /** The user's own hand: an event of type, trusted. */
  const hand = (type: string) => {
    trusted = true;
    document.dispatchEvent(new Event(type, { bubbles: true }));
  };
  return {
    message,
    scroller,
    hand,
    frames,
    frame,
    opened,
    win: win as { open: (u?: string, name?: string) => unknown; alert: (t?: unknown) => void; confirm: (t?: unknown) => boolean; prompt: (t?: unknown) => string | null; __cfFrame?: boolean },
    posted,
    notes,
    link,
    click,
    press,
    form,
    submit,
    went: () => went,
    reloads: () => reloads,
    nav,
  };
}

// oxlint-disable-next-line typescript/unbound-method -- put back as it was, on the prototype
const realClick = HTMLAnchorElement.prototype.click;
// oxlint-disable-next-line typescript/unbound-method -- put back as it was, on the prototype
const realSubmit = HTMLFormElement.prototype.submit;
/** The forms whose submit() went through to the browser's own (stubbed: jsdom has none). */
const submitted: string[] = [];
beforeEach(() => {
  HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
    submitted.push(this.action);
  };
});
afterEach(() => {
  // An opaque load's cookie jar is the document's own property: the prototype's comes back.
  delete (document as { cookie?: string }).cookie;
  for (const [type, fn, capture] of added.splice(0)) document.removeEventListener(type, fn, capture);
  document.body.replaceChildren();
  HTMLAnchorElement.prototype.click = realClick;
  HTMLFormElement.prototype.submit = realSubmit;
  submitted.length = 0;
});

describe("the frame script", () => {
  it("sends a clicked link to another site to the browser and keeps the frame where it is", () => {
    const f = load();
    expect(f.click(f.link({ href: "https://github.com/acme/app" }))).toBe(true);
    expect(f.click(f.link({ href: "https://example.com/a", target: "_blank" }))).toBe(true);
    expect(f.posted).toEqual([
      { type: "cf:open", url: "https://github.com/acme/app" },
      { type: "cf:open", url: "https://example.com/a" },
    ]);
    expect(f.went()).toBeNull();
  });

  it("leaves the page's own links to the frame; a _blank one loads there, with no window to open", () => {
    const f = load();
    expect(f.click(f.link({ href: `http://${HOST}/preview/g/other.html` }))).toBe(false);
    expect(f.click(f.link({ href: "#top" }))).toBe(false);
    expect(f.went()).toBeNull();
    expect(f.click(f.link({ href: `http://${HOST}/preview/g/other.html`, target: "_blank" }))).toBe(true);
    expect(f.went()).toBe(`http://${HOST}/preview/g/other.html`);
    expect(f.posted).toEqual([]);
  });

  it("leaves alone a click the page took, a script's click, and a link no browser opens", () => {
    const f = load();
    const taken = f.link({ href: "https://example.com/" });
    taken.addEventListener("click", (e) => {
      e.preventDefault();
    });
    f.click(taken);
    f.click(f.link({ href: "https://example.com/" }), "script");
    expect(f.click(f.link({ href: "mailto:a@example.com" }))).toBe(false);
    expect(f.click(f.link({ href: `https://example.com/${"a".repeat(2100)}` }))).toBe(true);
    expect(f.posted).toEqual([]);
  });

  it("window.open: another site goes to the browser after a press only; the page's own file loads in the frame", () => {
    const f = load();
    expect(f.win.open("https://example.com/x")).toBeNull();
    expect(f.posted).toEqual([]);
    f.press();
    f.win.open("https://example.com/x");
    expect(f.posted).toEqual([{ type: "cf:open", url: "https://example.com/x" }]);
    f.win.open(`http://${HOST}/preview/g/b.html`);
    expect(f.went()).toBe(`http://${HOST}/preview/g/b.html`);
    expect(f.posted).toHaveLength(1);
  });

  it("window.open with no page to load (a print view written in script) says it opened nothing", () => {
    const f = load();
    expect(f.win.open()).toBeNull();
    expect(f.win.open("", "_blank")).toBeNull();
    expect(f.win.open("about:blank")).toBeNull();
    expect(f.posted).toEqual([
      { type: "cf:unsupported", what: "window", text: "" },
      { type: "cf:unsupported", what: "window", text: "" },
      { type: "cf:unsupported", what: "window", text: "about:blank" },
    ]);
    expect(f.went()).toBeNull();
    expect(f.opened).toEqual([]);
  });

  it("window.open into a frame of the page by its name is the browser's; any other name loads in this frame", () => {
    const f = load();
    f.frame("viewer");
    f.win.open("b.html", "viewer");
    expect(f.opened).toEqual([["b.html", "viewer"]]);
    f.win.open("c.html", "nowhere");
    expect(f.went()).toBe(`http://${HOST}/c.html`);
    expect(f.opened).toHaveLength(1);
    expect(f.notes).toEqual(["cf:going"]);
  });

  describe("a link's target", () => {
    afterEach(() => {
      document.head.querySelectorAll("base").forEach((b) => {
        b.remove();
      });
    });

    it.each([
      ["_blank", {}],
      ["_new (a name no frame has)", { target: "_new" }],
      ["a name no frame has", { target: "viewer" }],
      ["_top", { target: "_TOP" }],
      ["_parent, from the page itself", { target: "_parent" }],
      ["_blank, in any case", { target: "_Blank" }],
    ])("loads the page's own file in the frame when it would open a window: %s", (_name, attrs) => {
      const f = load();
      expect(f.click(f.link({ href: "other.html", target: "_blank", ...attrs }))).toBe(true);
      expect(f.went()).toBe(`http://${HOST}/other.html`);
      expect(f.notes).toEqual(["cf:going"]);
    });

    it("takes the document's <base target> when the link names none, and the link's own over it", () => {
      const base = document.createElement("base");
      base.setAttribute("target", "_blank");
      document.head.append(base);
      const f = load();
      expect(f.click(f.link({ href: "a.html" }))).toBe(true);
      expect(f.went()).toBe(`http://${HOST}/a.html`);
      expect(f.click(f.link({ href: "b.html", target: "_self" }))).toBe(false);
      expect(f.went()).toBe(`http://${HOST}/a.html`);
      expect(f.click(f.link({ href: "https://example.com/" }))).toBe(true);
      expect(f.posted).toEqual([{ type: "cf:open", url: "https://example.com/" }]);
    });

    it("leaves a link into a frame of the page, by its name or this frame's own, to the browser, and says no going", () => {
      const f = load();
      f.frame("viewer");
      (f.win as unknown as { name: string }).name = "me";
      expect(f.click(f.link({ href: "a.html", target: "viewer" }))).toBe(false);
      expect(f.click(f.link({ href: "a.html", target: "Viewer" }))).toBe(true);
      expect(f.went()).toBe(`http://${HOST}/a.html`);
      expect(f.click(f.link({ href: "b.html", target: "me" }))).toBe(false);
      expect(f.notes).toEqual(["cf:going"]);
    });

    it("an element with the target's id is not a frame", () => {
      const f = load();
      (f.win as unknown as Record<string, unknown>).viewer = document.createElement("div");
      expect(f.click(f.link({ href: "a.html", target: "viewer" }))).toBe(true);
    });

    it("in a frame inside the page, _parent is the page's and _top would be the app's", () => {
      const f = load({ nested: true });
      expect(f.click(f.link({ href: "a.html", target: "_parent" }))).toBe(false);
      expect(f.click(f.link({ href: "b.html", target: "_top" }))).toBe(true);
      expect(f.went()).toBe(`http://${HOST}/b.html`);
    });
  });

  it("a GET form to the page's own file in a window loads it in the frame with its fields", () => {
    const f = load();
    expect(f.submit(f.form({ action: "results.html", target: "_blank" }, { q: "a b" }))).toBe(true);
    expect(f.went()).toBe(`http://${HOST}/results.html?q=a+b`);
    const button = document.createElement("button");
    button.setAttribute("formtarget", "_self");
    const own = f.form({ action: "next.html", target: "_blank" });
    own.append(button);
    expect(f.submit(own, "user", button)).toBe(false);
    expect(f.posted).toEqual([]);
  });

  it("a POST to the page's own files, which nothing answers, says so and stays", () => {
    const f = load();
    expect(f.submit(f.form({ method: "post" }, { email: "a@b.c" }))).toBe(true);
    f.form({ action: "save.html", method: "post" }).submit();
    // A form with no action is sent to its document's URL (jsdom's own here).
    expect(f.posted).toEqual([
      { type: "cf:unsupported", what: "post", text: window.location.pathname },
      { type: "cf:unsupported", what: "post", text: "/save.html" },
    ]);
    expect(submitted).toEqual([]);
    expect(f.notes).toEqual([]);
  });

  describe("in a frame inside the page", () => {
    it("sends on to the app what its own frames report, and nothing of anyone else's", () => {
      const f = load();
      const inner = {};
      f.frames.push(inner);
      f.message({ type: "cf:ping", seq: 1 });
      f.message({ type: "cf:open", url: "http://localhost:1/x" }, inner);
      f.message({ type: "cf:unsupported", what: "alert", text: "hi" }, inner);
      f.message({ type: "cf:unsupported", what: "download", text: "x".repeat(500) }, inner);
      f.message({ type: "cf:open", url: "javascript:alert(1)" }, inner);
      f.message({ type: "cf:going" }, inner);
      f.message({ type: "cf:here", seq: 1 }, inner);
      f.message({ type: "cf:open", url: "https://example.com/" }, {});
      f.message({ type: "cf:unsupported", what: "alert" }, {});
      f.message("cf:open", inner);
      expect(f.posted).toEqual([
        { type: "cf:open", url: "http://localhost:1/x" },
        { type: "cf:unsupported", what: "alert", text: "hi" },
        { type: "cf:unsupported", what: "download", text: "x".repeat(200) },
      ]);
      expect(f.notes).toEqual(["cf:here"]);
    });

    it("sends on what its frames report before the app's ping once it answered it (the frame's load clears the strip in between)", () => {
      const f = load();
      const inner = {};
      f.frames.push(inner);
      f.message({ type: "cf:unsupported", what: "storage", text: "localStorage" }, inner);
      expect(f.posted).toEqual([]);
      f.message({ type: "cf:ping", seq: 1 });
      expect(f.posted).toEqual([{ type: "cf:unsupported", what: "storage", text: "localStorage" }]);
    });

    it("tells the page of its own storage at once, with no ping to wait for", () => {
      const f = load({ nested: true, opaque: true });
      (f.win as unknown as { localStorage: Storage }).localStorage.setItem("k", "v");
      expect(f.posted).toEqual([{ type: "cf:unsupported", what: "storage", text: "localStorage" }]);
    });
  });

  it("alert, confirm and prompt answer as no dialog would and say so", () => {
    const f = load();
    f.win.alert("Saved");
    expect(f.win.confirm("Delete it?")).toBe(false);
    expect(f.win.prompt("Name")).toBeNull();
    f.win.alert("x".repeat(500));
    expect(f.posted.map((m) => [m.type, m.what, m.text?.length])).toEqual([
      ["cf:unsupported", "alert", 5],
      ["cf:unsupported", "confirm", 10],
      ["cf:unsupported", "prompt", 4],
      ["cf:unsupported", "alert", 200],
    ]);
  });

  it("a download says it saved nothing: a link in the page, and one made and clicked in script", () => {
    const f = load();
    expect(f.click(f.link({ href: "data:text/csv,a", download: "rows.csv" }))).toBe(true);
    f.link({ href: "blob:x", download: "export.json" }, false).click();
    expect(f.posted).toEqual([
      { type: "cf:unsupported", what: "download", text: "rows.csv" },
      { type: "cf:unsupported", what: "download", text: "export.json" },
    ]);
  });

  it("does nothing in a window of its own", () => {
    const f = load({ embedded: false });
    expect(f.win.__cfFrame).toBeUndefined();
    expect(f.click(f.link({ href: "https://example.com/" }))).toBe(false);
  });

  it("answers the app's ping with its seq, and only the app's", () => {
    const f = load();
    expect(f.notes).toEqual([]);
    const got: unknown[] = [];
    const parent = (f.win as unknown as { parent: { postMessage: (m: unknown) => void } }).parent;
    const post = parent.postMessage;
    parent.postMessage = (m) => {
      got.push(m);
      post(m);
    };
    f.message({ type: "cf:ping", seq: 3 });
    f.message({ type: "cf:ping", seq: 4 }, {});
    f.message({ type: "cf:ping", seq: "5" });
    f.message({ type: "cf:theme" });
    expect(got).toEqual([{ type: "cf:here", seq: 3, files: ["/preview/g/page.html"], theme: false, height: 0, loader: "" }]);
  });

  /** The script's answers to the app's ping, and its later file lists. */
  function answers(f: ReturnType<typeof load>) {
    const got: { type: string; files?: string[]; theme?: boolean }[] = [];
    const parent = (f.win as unknown as { parent: { postMessage: (m: { type: string }) => void } }).parent;
    const post = parent.postMessage;
    parent.postMessage = (m) => {
      if (m.type === "cf:here" || m.type === "cf:files") got.push(m);
      post(m);
    };
    return got;
  }

  it("says in its answer what it loaded from its own origin, itself first, and whether it uses the app's theme", () => {
    const f = load({ resources: [`http://${HOST}/preview/g/js/app.js`, "https://cdn.example.com/lib.js", `http://${HOST}/preview/g/data.json?x=1`] });
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/preview/g/css/site.css";
    document.body.append(css);
    const got = answers(f);
    f.message({ type: "cf:ping", seq: 1 });
    expect(got).toEqual([{ type: "cf:here", seq: 1, files: ["/preview/g/page.html", "/preview/g/js/app.js", "/preview/g/data.json", "/preview/g/css/site.css"], theme: false, height: 0, loader: "" }]);
    const theme = document.createElement("link");
    theme.rel = "stylesheet";
    theme.href = "/cf/theme.css";
    document.body.append(theme);
    f.message({ type: "cf:ping", seq: 2 });
    expect(got.at(-1)).toMatchObject({ theme: true });
  });

  it("on its grant's own host, lists the paths there, the app's theme and bridge among them", () => {
    const own = "http://0123456789abcdef0123456789abcdef.localhost:9246";
    const f = load({ at: `${own}/dist/index.html?cf-nonce=n#/about`, resources: [`${own}/assets/index.js`, `${own}/cf/theme.css`, `${own}/cf/bridge.js`, "http://127.0.0.1:9246/preview/g/x.css"] });
    const got = answers(f);
    f.message({ type: "cf:ping", seq: 1 });
    expect(got).toEqual([{ type: "cf:here", seq: 1, files: ["/dist/index.html", "/assets/index.js", "/cf/theme.css", "/cf/bridge.js"], theme: true, height: 0, loader: "" }]);
  });

  // A page check reads these (docs/notes/page-self-check.md).
  it("holds the page's errors until the app's ping, then tells each with where it was", () => {
    const f = load();
    const page = `http://${HOST}/preview/g/page.html`;
    document.dispatchEvent(new ErrorEvent("error", { error: new ReferenceError("Can't find variable: totl"), message: "x", filename: `${page}?cf-page=1`, lineno: 7, colno: 3 }));
    expect(f.posted).toEqual([]);
    f.message({ type: "cf:ping", seq: 1 });
    expect(f.posted).toEqual([{ type: "cf:script-error", kind: "script", message: "ReferenceError: Can't find variable: totl", where: "page.html:7:3" }]);
    // After the answer, at once: a rejection with its stack's place, a file that did not load, the loader's error and end.
    const rejected = Object.assign(new Event("unhandledrejection"), { reason: Object.assign(new TypeError("x is null"), { stack: `draw@${page}:12:9\nglobal code@${page}:20:1` }) });
    document.dispatchEvent(rejected);
    const script = document.createElement("script");
    script.src = "/preview/g/missing.js";
    document.body.append(script);
    script.dispatchEvent(new Event("error"));
    script.remove();
    document.dispatchEvent(new CustomEvent("cf:jsx", { detail: { error: "Syntax error in page.html\nUnexpected token (4:2)" } }));
    document.dispatchEvent(new CustomEvent("cf:jsx", { detail: { state: "error" } }));
    // The browser's own noise is not the page's.
    document.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
    expect(f.posted.slice(1)).toEqual([
      { type: "cf:script-error", kind: "rejection", message: "TypeError: x is null", where: "page.html:12:9" },
      { type: "cf:script-error", kind: "resource", message: "script did not load", where: `http://${HOST}/preview/g/missing.js` },
      { type: "cf:script-error", kind: "loader", message: "Syntax error in page.html\nUnexpected token (4:2)", where: "" },
      { type: "cf:loader", state: "error" },
    ]);
  });

  it("answers with the loader's state, and gives lines in the page's own file", () => {
    // The daemon writes the script in after <head>: its own lines push the page's down.
    Object.defineProperty(document, "currentScript", { configurable: true, value: { text: "a\nb\nc" } });
    try {
      const f = load();
      const got = answers(f);
      document.documentElement.dataset.cfJsx = "running";
      f.message({ type: "cf:ping", seq: 1 });
      expect(got[0]).toMatchObject({ loader: "running" });
      document.dispatchEvent(new ErrorEvent("error", { error: new Error("boom"), filename: `http://${HOST}/preview/g/page.html`, lineno: 10, colno: 1 }));
      document.dispatchEvent(new ErrorEvent("error", { error: new Error("boom"), filename: `http://${HOST}/preview/g/app.js`, lineno: 10, colno: 1 }));
      expect(f.posted.map((m) => (m as { where?: string }).where)).toEqual(["page.html:8:1", "app.js:10:1"]);
    } finally {
      delete document.documentElement.dataset.cfJsx;
      Reflect.deleteProperty(document, "currentScript");
    }
  });

  it("tells the app of files it fetched after it answered, not before", () => {
    const fire: (() => void)[] = [];
    const resources: string[] = [];
    const f = load({ resources, observe: (cb) => fire.push(cb) });
    const got = answers(f);
    resources.push(`http://${HOST}/preview/g/early.js`);
    fire[0]?.();
    expect(got).toEqual([]);
    f.message({ type: "cf:ping", seq: 1 });
    resources.push(`http://${HOST}/preview/g/rows.json`);
    fire[0]?.();
    // Nothing new: nothing said.
    fire[0]?.();
    expect(got.map((m) => [m.type, m.files])).toEqual([
      ["cf:here", ["/preview/g/page.html", "/preview/g/early.js"]],
      ["cf:files", ["/preview/g/page.html", "/preview/g/early.js", "/preview/g/rows.json"]],
    ]);
  });

  it("reloads itself when the app asks (one of its files was written), and only the app", () => {
    const f = load();
    f.message({ type: "cf:reload" }, {});
    expect(f.reloads()).toBe(0);
    f.message({ type: "cf:reload" });
    expect(f.reloads()).toBe(1);
  });

  describe("in an opaque origin (a page no thread owns)", () => {
    const storage = (f: ReturnType<typeof load>) => f.posted.filter((m) => m.what === "storage").map((m) => m.text);

    it("keeps localStorage and sessionStorage in memory, each its own, and says so at the first use of each", () => {
      const f = load({ opaque: true });
      f.message({ type: "cf:ping", seq: 1 });
      const w = f.win as unknown as { localStorage: Storage & Record<string, string>; sessionStorage: Storage };
      expect(w.localStorage.getItem("todos")).toBeNull();
      w.localStorage.setItem("todos", "[1]");
      w.localStorage.n = "2";
      expect(w.localStorage.getItem("todos")).toBe("[1]");
      expect(w.localStorage.getItem("n")).toBe("2");
      expect(w.localStorage.todos).toBe("[1]");
      expect(Object.keys(w.localStorage).sort()).toEqual(["n", "todos"]);
      expect(w.localStorage.length).toBe(2);
      expect(w.sessionStorage.getItem("todos")).toBeNull();
      w.localStorage.removeItem("todos");
      expect(w.localStorage.key(0)).toBe("n");
      w.localStorage.clear();
      expect(w.localStorage.length).toBe(0);
      expect(storage(f)).toEqual(["localStorage", "sessionStorage"]);
    });

    it("tells of a use before the app's ping once it answered it (the frame's load clears the strip in between)", () => {
      const f = load({ opaque: true });
      const w = f.win as unknown as { localStorage: Storage };
      w.localStorage.getItem("todos");
      expect(storage(f)).toEqual([]);
      f.message({ type: "cf:ping", seq: 1 });
      expect(storage(f)).toEqual(["localStorage"]);
      f.message({ type: "cf:ping", seq: 2 });
      expect(storage(f)).toEqual(["localStorage"]);
    });

    it("keeps cookies in memory, a past expiry removing one", () => {
      const f = load({ opaque: true });
      f.message({ type: "cf:ping", seq: 1 });
      document.cookie = "a=1; path=/";
      document.cookie = "b=2";
      expect(document.cookie).toBe("a=1; b=2");
      document.cookie = "a=; max-age=0";
      document.cookie = "b=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
      expect(document.cookie).toBe("");
      expect(storage(f)).toEqual(["document.cookie"]);
    });

    it("says indexedDB fails, which still throws, and takes the service worker and caches away", () => {
      const f = load({ opaque: true });
      f.message({ type: "cf:ping", seq: 1 });
      const w = f.win as unknown as { indexedDB: { open: (n: string) => unknown }; caches?: unknown };
      expect(() => w.indexedDB.open("db")).toThrow(/insecure/);
      expect(() => w.indexedDB.open("db")).toThrow(/insecure/);
      expect(storage(f)).toEqual(["indexedDB"]);
      expect("caches" in w).toBe(false);
      expect("serviceWorker" in f.nav).toBe(false);
    });

    it("leaves a page with storage alone", () => {
      const f = load();
      expect((f.win as { localStorage?: unknown }).localStorage).toBeUndefined();
      expect(f.posted).toEqual([]);
    });
  });

  it("says going before a link to its own origin, not to another site", () => {
    const f = load();
    f.click(f.link({ href: "https://example.com/" }));
    expect(f.notes).toEqual([]);
    f.click(f.link({ href: "data.json" }));
    expect(f.notes).toEqual(["cf:going"]);
  });

  it("sends a GET form to another site to the browser with its fields; a POST cannot go there and says so", () => {
    const f = load();
    expect(f.submit(f.form({ action: "https://example.com/search", method: "get" }, { q: "cats & dogs" }))).toBe(true);
    expect(f.submit(f.form({ action: "https://example.com/login", method: "post" }, { user: "me" }))).toBe(true);
    expect(f.posted).toEqual([
      { type: "cf:open", url: "https://example.com/search?q=cats+%26+dogs" },
      { type: "cf:unsupported", what: "form", text: "example.com" },
    ]);
  });

  it("takes a submit button's own action and method", () => {
    const f = load();
    const own = f.form({ action: "save.html", method: "post" });
    const button = document.createElement("button");
    button.setAttribute("formaction", "https://example.org/find");
    button.setAttribute("formmethod", "get");
    own.append(button);
    expect(f.submit(own, "user", button)).toBe(true);
    expect(f.posted).toEqual([{ type: "cf:open", url: "https://example.org/find" }]);
  });

  it("leaves the page's own forms, a form it sent itself, and a dialog's form alone", () => {
    const f = load();
    expect(f.submit(f.form({ action: "next.html" }, { q: "x" }))).toBe(false);
    expect(f.submit(f.form({}))).toBe(false);
    const taken = f.form({ action: "https://example.com/api", method: "post" });
    taken.addEventListener("submit", (e) => {
      e.preventDefault();
    });
    f.submit(taken);
    expect(f.submit(f.form({ action: "https://example.com/", method: "dialog" }))).toBe(false);
    expect(f.posted).toEqual([]);
  });

  it("sends a script's GET form to the browser only after a press, and reports it before one", () => {
    const f = load();
    expect(f.submit(f.form({ action: "https://example.com/s" }, { q: "a" }), "script")).toBe(true);
    f.press();
    f.submit(f.form({ action: "https://example.com/s" }, { q: "b" }), "script");
    expect(f.posted).toEqual([
      { type: "cf:unsupported", what: "form", text: "example.com" },
      { type: "cf:open", url: "https://example.com/s?q=b" },
    ]);
  });

  it("catches form.submit() to another site, which fires no submit event; the page's own goes through", () => {
    const f = load();
    f.form({ action: "https://example.com/login", method: "post" }).submit();
    f.form({ action: "next.html" }).submit();
    expect(f.posted).toEqual([{ type: "cf:unsupported", what: "form", text: "example.com" }]);
    expect(submitted).toEqual([`http://${HOST}/next.html`]);
  });

  describe("with the Navigation API", () => {
    function navigation() {
      const fns: ((e: unknown) => void)[] = [];
      const navigate = (url: string, over: Record<string, unknown> = {}) => {
        const e = { cancelable: true, userInitiated: false, navigationType: "push", destination: { url, sameDocument: false }, formData: null, downloadRequest: null, prevented: false, preventDefault: () => (e.prevented = true), ...over };
        for (const fn of fns) fn(e);
        return e.prevented;
      };
      return { api: { addEventListener: (t: string, fn: (e: unknown) => void) => t === "navigate" && fns.push(fn) }, navigate };
    }

    it("keeps the frame from a script's or a refresh's way to another site: to the browser after a press, else reported", () => {
      const n = navigation();
      const f = load({ navigation: n.api });
      expect(n.navigate("https://example.com/sso")).toBe(true);
      expect(n.navigate("https://example.com/next", { userInitiated: true })).toBe(true);
      expect(n.navigate("https://example.com/post", { formData: {} })).toBe(true);
      f.press();
      expect(n.navigate("https://example.com/later", { navigationType: "replace" })).toBe(true);
      expect(f.posted).toEqual([
        { type: "cf:unsupported", what: "navigation", text: "example.com" },
        { type: "cf:open", url: "https://example.com/next" },
        { type: "cf:unsupported", what: "form", text: "example.com" },
        { type: "cf:open", url: "https://example.com/later" },
      ]);
    });

    it("stops a POST to the page's own files there too", () => {
      const n = navigation();
      const f = load({ navigation: n.api });
      expect(n.navigate(`http://${HOST}/preview/g/page.html`, { formData: {} })).toBe(true);
      expect(f.posted).toEqual([{ type: "cf:unsupported", what: "post", text: "/preview/g/page.html" }]);
      expect(f.notes).toEqual([]);
    });

    it.each([
      ["the page's own file", `http://${HOST}/preview/g/other.html`, {}, true],
      ["the same document", "https://example.com/#x", { destination: { url: "https://example.com/#x", sameDocument: true } }, false],
      ["one it may not cancel (a step back)", "https://example.com/", { cancelable: false, navigationType: "traverse" }, false],
      ["a download", "https://example.com/a.csv", { downloadRequest: "a.csv" }, false],
      ["a URL no browser opens", "about:blank", {}, false],
    ])("lets a navigation go: %s", (_name, url, over, going) => {
      const n = navigation();
      const f = load({ navigation: n.api });
      expect(n.navigate(url, over)).toBe(false);
      expect(f.posted).toEqual([]);
      expect(f.notes).toEqual(going ? ["cf:going"] : []);
    });
  });

  it("posts what the app reads", () => {
    const f = load();
    f.click(f.link({ href: "https://github.com/acme/app" }));
    f.win.confirm("Sure?");
    expect(pageOpenUrl(f.posted[0])).toBe("https://github.com/acme/app");
    expect(pageUnsupported(f.posted[1])?.call).toBe("confirm()");
  });
});

describe("what the app reads from the frame script", () => {
  it.each([
    [{ type: "cf:open", url: "https://example.com/a?b=1" }, "https://example.com/a?b=1"],
    [{ type: "cf:open", url: "javascript:alert(1)" }, null],
    [{ type: "cf:open", url: "file:///etc/passwd" }, null],
    [{ type: "cf:open", url: "not a url" }, null],
    [{ type: "cf:open", url: `https://example.com/${"a".repeat(2100)}` }, null],
    [{ type: "cf:open", url: 3 }, null],
    [{ type: "cf:resize", url: "https://example.com/" }, null],
    [null, null],
  ])("pageOpenUrl(%j) is %j", (data, want) => {
    expect(pageOpenUrl(data)).toBe(want);
  });

  it("names each call a page cannot make, and nothing else", () => {
    for (const what of ["alert", "confirm", "prompt", "download", "form", "post", "navigation", "window"]) expect(pageUnsupported({ type: "cf:unsupported", what })?.message).toMatch(/page/);
    expect(pageUnsupported({ type: "cf:unsupported", what: "download" })?.message).toContain('cf.run("file.export"');
    expect(pageUnsupported({ type: "cf:unsupported", what: "toString" })).toBeNull();
    expect(pageUnsupported({ type: "cf:open", what: "alert" })).toBeNull();
  });
});

describe("the page's scroll (docs/notes/pages-tab-polish.md)", () => {
  const PATH = "/preview/g/page.html";
  const ping = (f: ReturnType<typeof load>, y: number, path = PATH) => {
    f.message({ type: "cf:ping", seq: 1, scroll: { x: 0, y, path } });
  };

  it("tells the app where it is scrolled to, at most once a frame, with its path", () => {
    const f = load();
    f.scroller.grow(2000);
    f.scroller.to(100);
    f.scroller.to(300);
    expect(f.posted).toEqual([]);
    f.scroller.frame();
    f.scroller.to(0);
    f.scroller.frame();
    expect(f.posted).toEqual([
      { type: "cf:scroll", x: 0, y: 300, path: PATH },
      { type: "cf:scroll", x: 0, y: 0, path: PATH },
    ]);
  });

  it("says nothing from a frame inside the page", () => {
    const f = load({ nested: true });
    f.scroller.grow(2000);
    f.scroller.to(100);
    f.scroller.frame();
    expect(f.posted).toEqual([]);
  });

  it("goes back where the app's ping says, and tries again as the document grows", () => {
    const f = load();
    f.scroller.grow(200);
    ping(f, 640);
    expect(f.scroller.y()).toBe(200);
    // The page drew more (its data came): the place can be reached now.
    f.scroller.grow(2000);
    expect(f.scroller.y()).toBe(640);
    // Reached: a later growth leaves the reader alone.
    f.scroller.to(10);
    f.scroller.grow(3000);
    expect(f.scroller.y()).toBe(10);
  });

  it.each([
    ["another file", `http://${HOST}${PATH}`, (f: ReturnType<typeof load>) => {
      ping(f, 640, "/preview/g/other.html");
    }, 0],
    ["a hash route or an anchor", `http://${HOST}${PATH}#/board`, (f: ReturnType<typeof load>) => {
      ping(f, 640);
    }, 0],
    ["a page that placed itself on load", `http://${HOST}${PATH}`, (f: ReturnType<typeof load>) => {
      f.scroller.to(50);
      ping(f, 640);
    }, 50],
    ["the user already scrolling", `http://${HOST}${PATH}`, (f: ReturnType<typeof load>) => {
      f.hand("wheel");
      ping(f, 640);
    }, 0],
  ])("leaves the page where it is: %s", (_name, at, act, want) => {
    const f = load({ at });
    f.scroller.grow(2000);
    act(f);
    expect(f.scroller.y()).toBe(want);
    f.scroller.grow(3000);
    expect(f.scroller.y()).toBe(want);
  });

  it.each([
    ["the user scrolls", (f: ReturnType<typeof load>) => {
      f.hand("wheel");
    }],
    ["the user presses a key", (f: ReturnType<typeof load>) => {
      f.hand("keydown");
    }],
    ["the page scrolls itself", (f: ReturnType<typeof load>) => {
      f.scroller.to(150);
    }],
  ])("stops trying once %s", (_name, then) => {
    const f = load();
    f.scroller.grow(200);
    ping(f, 640);
    then(f);
    const y = f.scroller.y();
    f.scroller.grow(2000);
    expect(f.scroller.y()).toBe(y);
  });

  it("stops trying after a while", () => {
    let now = 1000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const f = load();
      f.scroller.grow(200);
      ping(f, 640);
      now += 3001;
      f.scroller.grow(2000);
      expect(f.scroller.y()).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });
});
