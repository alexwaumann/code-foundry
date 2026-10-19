import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (ev: { data: unknown }) => void>();
vi.mock("@wailsio/runtime", () => ({
  Browser: { OpenURL: vi.fn() },
  Events: {
    On: (name: string, fn: (ev: { data: unknown }) => void) => {
      listeners.set(name, fn);
      return () => listeners.delete(name);
    },
  },
}));

const binding = vi.hoisted(() => ({ host: false, picked: null as string[] | null, startDir: "" }));
vi.mock("../../bindings/github.com/alexwaumann/code-foundry/gui/appservice", () => ({
  Info: () => (binding.host ? Promise.resolve({ version: "v1" }) : Promise.reject(new Error("no host"))),
  PickFiles: (startDir: string) => {
    binding.startDir = startDir;
    return Promise.resolve(binding.picked);
  },
}));

beforeEach(() => {
  vi.resetModules();
  listeners.clear();
  binding.host = false;
  binding.picked = null;
  binding.startDir = "";
});

describe("filesDroppedOf", () => {
  it.each([
    { name: "a drop", data: { paths: ["/a/x.png", "/b"], target: "r1" }, want: { paths: ["/a/x.png", "/b"], target: "r1" } },
    { name: "no target id", data: { paths: ["/a"], target: "" }, want: { paths: ["/a"], target: "" } },
    { name: "drops empty and non-string paths", data: { paths: ["", 3, "/a"], target: "r1" }, want: { paths: ["/a"], target: "r1" } },
    { name: "no paths left", data: { paths: [""], target: "r1" }, want: null },
    { name: "paths not a list", data: { paths: "/a", target: "r1" }, want: null },
    { name: "target missing", data: { paths: ["/a"] }, want: null },
    { name: "null", data: null, want: null },
    { name: "a string", data: "/a", want: null },
  ])("$name", async ({ data, want }) => {
    const { filesDroppedOf } = await import("./app");
    expect(filesDroppedOf(data)).toEqual(want);
  });
});

describe("onFilesDropped", () => {
  it("calls back with each well-formed drop and unsubscribes", async () => {
    const { EVENT_FILES_DROPPED, onFilesDropped } = await import("./app");
    const got: unknown[] = [];
    const off = onFilesDropped((d) => got.push(d));
    const fire = listeners.get(EVENT_FILES_DROPPED);
    expect(EVENT_FILES_DROPPED).toBe("app:files-dropped");
    fire?.({ data: { paths: ["/a/x.png"], target: "r1" } });
    fire?.({ data: { nonsense: true } });
    expect(got).toEqual([{ paths: ["/a/x.png"], target: "r1" }]);
    off();
    expect(listeners.has(EVENT_FILES_DROPPED)).toBe(false);
  });
});

describe("pickFiles", () => {
  it("is null without a host (the binding is not called)", async () => {
    const { pickFiles } = await import("./app");
    expect(await pickFiles("/src/web")).toBeNull();
    expect(binding.startDir).toBe("");
  });

  it("returns the host's paths, [] for a cancel", async () => {
    binding.host = true;
    const { pickFiles } = await import("./app");
    binding.picked = ["/src/web/a.png", "/src/web/notes.txt"];
    expect(await pickFiles("/src/web")).toEqual(["/src/web/a.png", "/src/web/notes.txt"]);
    expect(binding.startDir).toBe("/src/web");
    binding.picked = null;
    expect(await pickFiles("")).toEqual([]);
  });
});
