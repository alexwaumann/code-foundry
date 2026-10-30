import { afterEach, describe, expect, it } from "vitest";
import { emptyBottom, getBottom, sanitizeBottomState, toggleBottom, useBottomStore } from "./bottomPanel";
import { setPreviewMode, useCodeViewStore } from "./codeView";
import { usePanelStore } from "./panel";
import { addRecentReviewer, useReviewerRecentsStore } from "./reviewerRecents";
import { useSettingsPrefsStore } from "./settingsPrefs";
import { FONT_MAX, FONT_DEFAULT, HOME, SIDEBAR_DEFAULT, SIDEBAR_MIN, useUiStore, ZOOM_DEFAULT, ZOOM_MAX } from "./ui";

// Every persisted store, with what a well-formed state must look like after loading and a
// use of its reducers (what used to throw on a bad shape: getBottom on byKey null).
interface Persisted {
  name: string;
  version: number;
  rehydrate: () => Promise<void> | void;
  /** Field names the persisted state has (each is fed garbage in turn). */
  fields: string[];
  /** Exercises the store's getters and reducers; throws if its state is not usable. */
  use: () => void;
}

const stores: Persisted[] = [
  {
    name: "code-foundry.bottom",
    version: 1,
    rehydrate: () => useBottomStore.persist.rehydrate(),
    fields: ["byKey"],
    use: () => {
      getBottom("thread:x");
      toggleBottom("thread:x", true);
      expect(getBottom("thread:x").open).toBe(true);
    },
  },
  {
    name: "code-foundry.panel",
    version: 3,
    rehydrate: () => usePanelStore.persist.rehydrate(),
    fields: ["byKey"],
    use: () => {
      for (const e of Object.values(usePanelStore.getState().byKey)) expect(e.groups[0]?.tabs).toBeInstanceOf(Array);
    },
  },
  {
    name: "code-foundry.ui",
    version: 3,
    rehydrate: () => useUiStore.persist.rehydrate(),
    fields: ["sidebarVisible", "sidebarWidth", "fontSize", "zoom", "usageRange", "workingCollapsed", "archivedCollapsed", "snoozedCollapsed", "collapsedProjects", "collapsedWorkspaces", "emberShowWork", "selection"],
    use: () => {
      const s = useUiStore.getState();
      for (const n of [s.sidebarWidth, s.fontSize, s.zoom]) expect(Number.isFinite(n)).toBe(true);
      expect(typeof s.sidebarVisible).toBe("boolean");
      expect(s.collapsedProjects).toBeInstanceOf(Array);
      expect(s.selection).toEqual(HOME);
    },
  },
  {
    name: "code-foundry.codeView",
    version: 1,
    rehydrate: () => useCodeViewStore.persist.rehydrate(),
    fields: ["diffStyle", "wrap", "preview"],
    use: () => {
      const s = useCodeViewStore.getState();
      expect(["unified", "split"]).toContain(s.diffStyle);
      expect(["rendered", "source"]).toContain(s.preview.markdown);
      setPreviewMode("html", "source");
    },
  },
  {
    name: "code-foundry.reviewerRecents",
    version: 1,
    rehydrate: () => useReviewerRecentsStore.persist.rehydrate(),
    fields: ["bySlug"],
    use: () => {
      addRecentReviewer("o/r", { login: "a", name: "", avatarUrl: "", kind: "user" });
      for (const list of Object.values(useReviewerRecentsStore.getState().bySlug)) for (const r of list) expect(typeof r.login.toLowerCase()).toBe("string");
    },
  },
  {
    name: "code-foundry.settingsPrefs",
    version: 1,
    rehydrate: () => useSettingsPrefsStore.persist.rehydrate(),
    fields: ["boundOnly"],
    use: () => {
      expect(typeof useSettingsPrefsStore.getState().boundOnly).toBe("boolean");
    },
  },
];

const garbage: unknown[] = [null, [], [1, 2], 0, -1, Number.MAX_VALUE, "x", true, { nested: null }, [null], { k: null }, { k: [] }, { k: "yes" }, { k: { open: "yes", height: "x", groups: {}, tabs: null } }];

afterEach(() => {
  localStorage.clear();
});

async function load(s: Persisted, state: unknown, version = s.version): Promise<void> {
  localStorage.setItem(s.name, JSON.stringify({ state, version }));
  await s.rehydrate();
}

describe.each(stores)("persisted store $name", (s) => {
  it.each(garbage)("loads a whole state of %j", async (state) => {
    await load(s, state);
    s.use();
  });

  it.each(s.fields.flatMap((f) => garbage.map((g) => [f, g] as const)))("loads %s = %j", async (field, value) => {
    await load(s, { [field]: value });
    s.use();
  });

  it("loads a store from a newer build", async () => {
    await load(s, { [s.fields[0] ?? "x"]: { k: 1 } }, s.version + 7);
    s.use();
  });
});

describe("repairs", () => {
  it("bottom: keeps object entries, a boolean open, a finite height and a string tab", () => {
    expect(sanitizeBottomState({ a: null, b: [1], c: { open: "yes", height: "x" }, d: { open: true, height: 300, activeTerminalId: "t" }, e: { height: Infinity, activeTerminalId: 3 } })).toEqual({
      c: { open: false },
      d: { open: true, height: 300, activeTerminalId: "t" },
      e: { open: false },
    });
    expect(sanitizeBottomState(null)).toEqual({});
    expect(getBottom("thread:none")).toEqual(emptyBottom);
  });

  it("ui: numbers are clamped, wrong types fall back to the defaults", async () => {
    const ui = stores.find((x) => x.name === "code-foundry.ui") as Persisted;
    const reset = () => {
      useUiStore.setState({ sidebarWidth: SIDEBAR_DEFAULT, fontSize: FONT_DEFAULT, zoom: ZOOM_DEFAULT });
    };
    reset();
    await load(ui, { sidebarWidth: "wide", fontSize: 1000, zoom: null });
    expect(useUiStore.getState()).toMatchObject({ sidebarWidth: SIDEBAR_DEFAULT, fontSize: FONT_MAX, zoom: ZOOM_DEFAULT });
    reset();
    await load(ui, { sidebarWidth: 10, fontSize: "13", zoom: 10_000 });
    expect(useUiStore.getState()).toMatchObject({ sidebarWidth: SIDEBAR_MIN, fontSize: FONT_DEFAULT, zoom: ZOOM_MAX });
  });
});
