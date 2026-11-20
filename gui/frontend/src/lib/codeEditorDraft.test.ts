import { beforeAll, describe, expect, it, vi } from "vitest";

// The library, reduced to what the drafts use: an editor that keeps its options (so a test
// can fire its onChange) and the documents by key.
const lib = vi.hoisted(() => ({ docs: new Map<string, string>(), editors: [] as { options: { onChange?: (e: unknown) => void } }[], reads: 0 }));
vi.mock("@pierre/diffs/edit", () => ({
  Editor: class {
    constructor(
      readonly type: string,
      readonly options: { onChange?: (e: unknown) => void },
      readonly key?: string,
    ) {
      lib.editors.push(this);
    }
  },
  EditStateManager: {
    get: (_type: string, key: string) => {
      const text = lib.docs.get(key);
      return text === undefined
        ? undefined
        : {
            document: {
              getText: () => {
                lib.reads++;
                return text;
              },
            },
          };
    },
    clear: () => true,
  },
}));

const { createCodeEditor, draftSnapshot, loadCodeEditor, subscribeDraft } = await import("./codeEditor");

beforeAll(async () => {
  await loadCodeEditor();
});

function editorFor(key: string | undefined, onChange?: (e: unknown) => void) {
  createCodeEditor("file", onChange ? { onChange } : {}, key);
  const e = lib.editors.at(-1);
  if (!e) throw new Error("no editor");
  return { change: (event: unknown = {}) => e.options.onChange?.(event) };
}

describe("following a draft", () => {
  it("an editor's change reaches its own onChange first, then the key's readers", () => {
    const order: string[] = [];
    const ed = editorFor("a", () => order.push("own"));
    const stop = subscribeDraft("a", () => order.push("reader"));
    ed.change();
    expect(order).toEqual(["own", "reader"]);
    stop();
    ed.change();
    expect(order).toEqual(["own", "reader", "own"]);
  });

  it("a reader hears only its key", () => {
    const a = editorFor("k1");
    const b = editorFor("k2");
    const heard = vi.fn();
    const stop = subscribeDraft("k1", heard);
    b.change();
    expect(heard).not.toHaveBeenCalled();
    a.change();
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
  });

  it("an editor without a key reports to nobody", () => {
    const ed = editorFor(undefined);
    expect(() => {
      ed.change();
    }).not.toThrow();
  });

  it("reads the text once per change, and again only after one", () => {
    lib.docs.set("s", "one");
    const ed = editorFor("s");
    const stop = subscribeDraft("s", () => undefined);
    lib.reads = 0;
    expect(draftSnapshot("s")).toBe("one");
    expect(draftSnapshot("s")).toBe("one");
    expect(lib.reads).toBe(1);
    lib.docs.set("s", "two");
    expect(draftSnapshot("s")).toBe("one");
    ed.change();
    expect(draftSnapshot("s")).toBe("two");
    expect(lib.reads).toBe(2);
    stop();
  });

  it("a key with no document yet is read again, so an editor attaching later is seen", () => {
    const stop = subscribeDraft("late", () => undefined);
    expect(draftSnapshot("late")).toBeNull();
    lib.docs.set("late", "attached");
    expect(draftSnapshot("late")).toBe("attached");
    stop();
  });

  it("without a reader the text is read fresh each time", () => {
    lib.docs.set("free", "x");
    expect(draftSnapshot("free")).toBe("x");
    lib.docs.set("free", "y");
    expect(draftSnapshot("free")).toBe("y");
  });
});
