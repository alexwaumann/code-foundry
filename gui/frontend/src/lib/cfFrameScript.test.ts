import { afterEach, describe, expect, it } from "vitest";
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

function load(opts: { embedded?: boolean } = {}) {
  const posted: Msg[] = [];
  let trusted = true;
  let went: string | null = null;
  const win: Record<string, unknown> = {
    // Events are dispatched untrusted in jsdom: the listener sees them as `trusted` says.
    addEventListener: (type: string, fn: (e: Event) => void, capture?: boolean) => {
      const seen: EventListener = (e) => {
        fn(
          new Proxy(e, {
            get: (t, k) => {
              if (k === "isTrusted") return trusted;
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
  win.parent = opts.embedded === false ? win : { postMessage: (m: Msg) => posted.push(structuredClone(m)) };
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
  return { win: win as { open: (u?: string) => unknown; alert: (t?: unknown) => void; confirm: (t?: unknown) => boolean; prompt: (t?: unknown) => string | null; __cfFrame?: boolean }, posted, link, click, press, went: () => went };
}

// oxlint-disable-next-line typescript/unbound-method -- put back as it was, on the prototype
const realClick = HTMLAnchorElement.prototype.click;
afterEach(() => {
  for (const [type, fn, capture] of added.splice(0)) document.removeEventListener(type, fn, capture);
  document.body.replaceChildren();
  HTMLAnchorElement.prototype.click = realClick;
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
    for (const what of ["alert", "confirm", "prompt", "download"]) expect(pageUnsupported({ type: "cf:unsupported", what })?.message).toMatch(/page/);
    expect(pageUnsupported({ type: "cf:unsupported", what: "download" })?.message).toContain('cf.run("file.export"');
    expect(pageUnsupported({ type: "cf:unsupported", what: "toString" })).toBeNull();
    expect(pageUnsupported({ type: "cf:open", what: "alert" })).toBeNull();
  });
});
