import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

function load(opts: { embedded?: boolean; navigation?: object; opaque?: boolean; resources?: string[]; observe?: (cb: () => void) => void } = {}) {
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
  if (opts.navigation) win.navigation = opts.navigation;
  const location = {
    host: HOST,
    get href() {
      return `http://${HOST}/preview/g/page.html`;
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
  return {
    message,
    win: win as { open: (u?: string) => unknown; alert: (t?: unknown) => void; confirm: (t?: unknown) => boolean; prompt: (t?: unknown) => string | null; __cfFrame?: boolean },
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
    f.win.open();
    expect(f.posted).toHaveLength(1);
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
    expect(got).toEqual([{ type: "cf:here", seq: 3, files: ["/preview/g/page.html"], theme: false }]);
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
    expect(got).toEqual([{ type: "cf:here", seq: 1, files: ["/preview/g/page.html", "/preview/g/js/app.js", "/preview/g/data.json", "/preview/g/css/site.css"], theme: false }]);
    const theme = document.createElement("link");
    theme.rel = "stylesheet";
    theme.href = "/cf/theme.css";
    document.body.append(theme);
    f.message({ type: "cf:ping", seq: 2 });
    expect(got.at(-1)).toMatchObject({ theme: true });
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
    for (const what of ["alert", "confirm", "prompt", "download", "form", "navigation"]) expect(pageUnsupported({ type: "cf:unsupported", what })?.message).toMatch(/page/);
    expect(pageUnsupported({ type: "cf:unsupported", what: "download" })?.message).toContain('cf.run("file.export"');
    expect(pageUnsupported({ type: "cf:unsupported", what: "toString" })).toBeNull();
    expect(pageUnsupported({ type: "cf:open", what: "alert" })).toBeNull();
  });
});
