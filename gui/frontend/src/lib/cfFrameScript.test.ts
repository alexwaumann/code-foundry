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

function load(opts: { embedded?: boolean; navigation?: object } = {}) {
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
  };
  // The script under test, as the daemon inlines it, with these globals.
  // oxlint-disable-next-line typescript/no-implied-eval
  const run = new Function("window", "document", "location", "navigator", SRC) as (...globals: unknown[]) => void;
  run(win, document, location, { userActivation: null });
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
    expect(got).toEqual([{ type: "cf:here", seq: 3 }]);
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
