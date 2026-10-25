import { describe, expect, it } from "vitest";
import type { ArgSpecView } from "@/api/command";
import { BRIDGE_LIMITS, BRIDGE_SOURCES, errorResult, fillPageArgs, frameNonce, jsonSafe, nonceMatches, okResult, parsePageMessage, readyMessage, resultJson, withNonce, type PageMessage } from "./bridge";

describe("parsePageMessage", () => {
  const cases: { name: string; data: unknown; want: PageMessage | null }[] = [
    { name: "a run", data: { cf: 1, type: "cf:run", id: "r1", verb: "thread.list", args: { archived: "true" } }, want: { kind: "run", id: "r1", verb: "thread.list", args: { archived: "true" } } },
    { name: "a run without args", data: { cf: 1, type: "cf:run", id: 7, verb: " ui.notify " }, want: { kind: "run", id: 7, verb: "ui.notify", args: {} } },
    { name: "a run whose arg is not a string", data: { cf: 1, type: "cf:run", id: "r", verb: "x", args: { n: 5 } }, want: { kind: "bad", id: "r", call: "x", message: "cf:run arg n must be a string" } },
    { name: "a run whose args are an array", data: { cf: 1, type: "cf:run", id: "r", verb: "x", args: ["a"] }, want: { kind: "bad", id: "r", call: "x", message: "cf:run args must be an object of strings" } },
    { name: "a run without a verb", data: { cf: 1, type: "cf:run", id: "r", verb: "" }, want: { kind: "bad", id: "r", call: "cf.run", message: "cf:run needs a verb" } },
    { name: "a subscription", data: { cf: 1, type: "cf:on", id: "s1", source: "thread-list" }, want: { kind: "on", id: "s1", source: "thread-list" } },
    { name: "a subscription without a source", data: { cf: 1, type: "cf:on", id: "s1" }, want: { kind: "bad", id: "s1", call: "cf.on", message: "cf:on needs a source" } },
    { name: "an off", data: { cf: 1, type: "cf:off", id: "s1" }, want: { kind: "off", id: "s1" } },
    { name: "a hello", data: { cf: 1, type: "cf:hello" }, want: { kind: "hello" } },
    { name: "a bye", data: { cf: 1, type: "cf:bye", nonce: "n" }, want: { kind: "bye" } },
    { name: "a run at the size cap", data: { cf: 1, type: "cf:run", id: "r", verb: "x", args: { b: "y".repeat(BRIDGE_LIMITS.messageChars - 12) } }, want: { kind: "run", id: "r", verb: "x", args: { b: "y".repeat(BRIDGE_LIMITS.messageChars - 12) } } },
    { name: "a run past the size cap is ignored", data: { cf: 1, type: "cf:run", id: "r", verb: "x", args: { b: "y".repeat(BRIDGE_LIMITS.messageChars) } }, want: null },
    { name: "a store past the size cap is ignored", data: { cf: 1, type: "cf:store", id: "w", key: "k", value: "y".repeat(BRIDGE_LIMITS.messageChars) }, want: null },
    { name: "a store", data: { cf: 1, type: "cf:store", id: "w1", key: "todo:items", value: "[1,2]" }, want: { kind: "store", id: "w1", key: "todo:items", value: "[1,2]" } },
    { name: "a removal", data: { cf: 1, type: "cf:store", id: "w1", key: "k", value: null }, want: { kind: "store", id: "w1", key: "k", value: null } },
    { name: "a store without a key", data: { cf: 1, type: "cf:store", id: "w1", value: "1" }, want: { kind: "bad", id: "w1", call: "cf.storage", message: "cf:store needs a key" } },
    { name: "a store of a value that is not text", data: { cf: 1, type: "cf:store", id: "w1", key: "k", value: 1 }, want: { kind: "bad", id: "w1", call: "cf.storage", message: "cf:store value must be JSON text or null" } },
    { name: "a cancel", data: { cf: 1, type: "cf:cancel", id: "r1" }, want: { kind: "cancel", id: "r1" } },
    {
      name: "a fetch",
      data: { cf: 1, type: "cf:fetch", id: "f1", url: "https://a.example/x", method: "POST", headers: { Authorization: "t" }, body: "{}", timeout: 5000 },
      want: { kind: "fetch", id: "f1", url: "https://a.example/x", method: "POST", headers: { Authorization: "t" }, body: "{}", timeout: 5000 },
    },
    { name: "a bare fetch: GET, 30 s", data: { cf: 1, type: "cf:fetch", id: "f1", url: "https://a.example/" }, want: { kind: "fetch", id: "f1", url: "https://a.example/", method: "GET", headers: {}, body: "", timeout: 30000 } },
    { name: "a fetch's timeout is cut to 120 s", data: { cf: 1, type: "cf:fetch", id: "f1", url: "u", timeout: 1e9 }, want: { kind: "fetch", id: "f1", url: "u", method: "GET", headers: {}, body: "", timeout: 120000 } },
    { name: "a fetch without a url", data: { cf: 1, type: "cf:fetch", id: "f1" }, want: { kind: "bad", id: "f1", call: "cf.fetch", message: "cf:fetch needs a url" } },
    { name: "a fetch whose header is not a string", data: { cf: 1, type: "cf:fetch", id: "f1", url: "u", headers: { n: 1 } }, want: { kind: "bad", id: "f1", call: "cf.fetch", message: "cf:fetch header n must be a string" } },
    { name: "a fetch whose body is not text", data: { cf: 1, type: "cf:fetch", id: "f1", url: "u", body: { a: 1 } }, want: { kind: "bad", id: "f1", call: "cf.fetch", message: "cf:fetch body must be a string" } },
    { name: "a fetch with a 1 MiB body is heard", data: { cf: 1, type: "cf:fetch", id: "f1", url: "u", method: "PUT", body: "y".repeat(1 << 20) }, want: { kind: "fetch", id: "f1", url: "u", method: "PUT", headers: {}, body: "y".repeat(1 << 20), timeout: 30000 } },
    { name: "a fetch past its cap is ignored", data: { cf: 1, type: "cf:fetch", id: "f1", url: "u", body: "y".repeat(BRIDGE_LIMITS.fetchChars) }, want: null },
    { name: "no cf marker", data: { type: "cf:run", id: "r", verb: "x" }, want: null },
    { name: "another version", data: { cf: 2, type: "cf:run", id: "r", verb: "x" }, want: null },
    { name: "no id", data: { cf: 1, type: "cf:run", verb: "x" }, want: null },
    { name: "an empty id", data: { cf: 1, type: "cf:run", id: "", verb: "x" }, want: null },
    { name: "cf:resize is not the bridge's", data: { cf: 1, type: "cf:resize", height: 10 }, want: null },
    { name: "not an object", data: "cf:run", want: null },
    { name: "null", data: null, want: null },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(parsePageMessage(c.data)).toEqual(c.want);
    });
  }
});

describe("the frame's nonce", () => {
  it("is 128 random bits in hex, new each time", () => {
    const a = frameNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(frameNonce()).not.toBe(a);
  });

  it.each([
    ["a URL without a fragment", "http://h/preview/g/a.html", "http://h/preview/g/a.html#cf=n1"],
    ["after the URL's own fragment", "http://h/preview/g/a.html#top", "http://h/preview/g/a.html#top&cf=n1"],
    ["an empty fragment", "http://h/preview/g/a.html#", "http://h/preview/g/a.html#cf=n1"],
  ])("goes in the fragment of %s", (_name, url, want) => {
    expect(withNonce(url, "n1")).toBe(want);
  });

  it.each([
    ["the frame's", { type: "cf:run", nonce: "n1" }, false, true],
    ["another frame's", { type: "cf:run", nonce: "n2" }, false, false],
    ["none", { type: "cf:run" }, false, false],
    ["none, where it is optional", { type: "cf:resize" }, true, true],
    ["another frame's, where it is optional", { type: "cf:resize", nonce: "n2" }, true, false],
    ["a number", { type: "cf:run", nonce: 1 }, false, false],
    ["not an object", "cf:run", true, false],
  ])("matches a message carrying %s", (_name, data, optional, want) => {
    expect(nonceMatches(data, "n1", optional)).toBe(want);
  });
});

describe("fillPageArgs", () => {
  const spec = (name: string, more: Partial<ArgSpecView> = {}): ArgSpecView => ({ name, type: "string", required: false, description: "", enumValues: [], defaultValue: "", ...more });
  const place = { threadId: "t-1", cwd: "/wt/app" };
  const cases: { name: string; args: Record<string, string>; specs: ArgSpecView[]; place?: typeof place; want: Record<string, string> }[] = [
    { name: "the thread for an arg that defaults to it", args: { prompt: "hi" }, specs: [spec("created-by", { defaultToThreadEnv: true }), spec("prompt")], want: { prompt: "hi", "created-by": "t-1" } },
    { name: "a page's own value wins", args: { "created-by": "t-2" }, specs: [spec("created-by", { defaultToThreadEnv: true })], want: { "created-by": "t-2" } },
    { name: "an explicit empty value stays (the CLI's --flag=)", args: { "created-by": "" }, specs: [spec("created-by", { defaultToThreadEnv: true })], want: { "created-by": "" } },
    { name: "the thread's checkout for an arg that defaults to the cwd", args: {}, specs: [spec("cwd", { type: "path", defaultToCwd: true })], want: { cwd: "/wt/app" } },
    { name: "the cwd the page passed", args: { here: "/elsewhere" }, specs: [spec("here", { type: "path", defaultToCwd: true })], want: { here: "/elsewhere" } },
    { name: "no cwd when the thread's checkout is unknown", args: {}, specs: [spec("here", { type: "path", defaultToCwd: true })], place: { threadId: "t-1", cwd: "" }, want: {} },
    { name: "a verb that starts a thread does not move the view", args: { prompt: "go" }, specs: [spec("prompt"), spec("focus", { type: "bool", defaultValue: "true" })], want: { prompt: "go", focus: "false" } },
    { name: "unless the page asks", args: { focus: "true" }, specs: [spec("focus", { type: "bool", defaultValue: "true" })], want: { focus: "true" } },
    { name: "a focus that is off by default is left alone", args: {}, specs: [spec("focus", { type: "bool" })], want: {} },
    { name: "nothing else", args: {}, specs: [spec("prompt")], want: {} },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(fillPageArgs(c.args, c.specs, c.place ?? place)).toEqual(c.want);
    });
  }
});

describe("replies", () => {
  it("ready names the thread, its read-only verbs (sorted) and every source", () => {
    const theme = { id: "github-dark", scheme: "dark" as const, vars: { "--cf-text": "#ffffff" } };
    expect(readyMessage({ id: "t", name: "Fix" }, theme, ["thread.list", "action.list"], { n: "3" })).toEqual({
      type: "cf:ready",
      cf: 1,
      thread: { id: "t", name: "Fix" },
      theme,
      readOnly: ["action.list", "thread.list"],
      sources: [...BRIDGE_SOURCES],
      storage: { n: "3" },
    });
  });
  it("ready without a thread offers nothing", () => {
    const m = readyMessage(null, { id: "x", scheme: "light", vars: {} }, ["thread.list"], { n: "3" });
    expect(m.thread).toBeNull();
    expect(m.readOnly).toEqual([]);
    expect(m.sources).toEqual([]);
    expect(m.storage).toEqual({});
  });
  it("a result carries the text and the parsed JSON", () => {
    expect(okResult("r", { message: "done", resultJson: '{"a":1}' })).toEqual({ type: "cf:result", id: "r", ok: true, result: { text: "done", json: { a: 1 } } });
    expect(okResult("r", { message: "", resultJson: "" })).toEqual({ type: "cf:result", id: "r", ok: true, result: { text: "", json: null } });
  });
  it("a declined call carries what was already done", () => {
    expect(errorResult(3, { code: "declined", message: "no" }, { message: "removed 2", resultJson: "" })).toEqual({ type: "cf:result", id: 3, ok: false, error: { code: "declined", message: "no" }, result: { text: "removed 2", json: null } });
    expect(errorResult(3, { code: "failed", message: "x" })).toEqual({ type: "cf:result", id: 3, ok: false, error: { code: "failed", message: "x" } });
  });
  it("resultJson tolerates text that is not JSON", () => {
    expect(resultJson("not json")).toBeNull();
  });
  it("jsonSafe turns dates into strings and drops undefined fields", () => {
    expect(jsonSafe({ at: new Date(0), gone: undefined, n: 1 })).toEqual({ at: "1970-01-01T00:00:00.000Z", n: 1 });
    expect(jsonSafe(undefined)).toBeNull();
  });
});
