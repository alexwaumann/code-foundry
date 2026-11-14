import { afterEach, describe, expect, it } from "vitest";
import { setPreviewMode, useCodeViewStore } from "./codeView";
import { addRecentFile, useRecentFilesStore } from "./recentFiles";
import { addRecentReviewer, useReviewerRecentsStore } from "./reviewerRecents";
import { lastSearchMode, setSearchMode, useSearchDialogStore } from "./searchDialog";
import { useSettingsPrefsStore } from "./settingsPrefs";
import { toggleNeedsCollapsed, useShellSidebarStore } from "./shellSidebar";
import { FONT_MAX, FONT_DEFAULT, HOME, SIDEBAR_DEFAULT, SIDEBAR_MIN, useUiStore, ZOOM_DEFAULT, ZOOM_MAX } from "./ui";

// Every persisted store, with what a well-formed state must look like after loading and a
// use of its reducers (what used to throw on a bad shape). The classic window's
// "code-foundry.panel" and "code-foundry.bottom" have no store any more: the first-load
// import reads them as raw strings (shell/legacyImport.ts).
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
    name: "code-foundry.ui",
    version: 4,
    rehydrate: () => useUiStore.persist.rehydrate(),
    fields: ["sidebarVisible", "sidebarWidth", "fontSize", "zoom", "usageRange", "workingCollapsed", "archivedCollapsed", "snoozedCollapsed", "emberShowWork", "selection"],
    use: () => {
      const s = useUiStore.getState();
      for (const n of [s.sidebarWidth, s.fontSize, s.zoom]) expect(Number.isFinite(n)).toBe(true);
      expect(typeof s.sidebarVisible).toBe("boolean");
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
  {
    name: "code-foundry.shellSidebar",
    version: 1,
    rehydrate: () => useShellSidebarStore.persist.rehydrate(),
    fields: ["needsCollapsed", "activeCollapsed"],
    use: () => {
      toggleNeedsCollapsed();
      expect(typeof useShellSidebarStore.getState().needsCollapsed).toBe("boolean");
      expect(typeof useShellSidebarStore.getState().activeCollapsed).toBe("boolean");
    },
  },
  {
    name: "code-foundry.recent-files",
    version: 1,
    rehydrate: () => useRecentFilesStore.persist.rehydrate(),
    fields: ["byKey"],
    use: () => {
      addRecentFile("thread:x", { project: "p", base: "/w", path: "/w/a.go" });
      for (const list of Object.values(useRecentFilesStore.getState().byKey)) for (const f of list) expect(f.path.startsWith("/")).toBe(true);
    },
  },
  {
    name: "code-foundry.searchDialog",
    version: 1,
    rehydrate: () => useSearchDialogStore.persist.rehydrate(),
    fields: ["mode"],
    use: () => {
      expect(["agent", "find"]).toContain(lastSearchMode());
      setSearchMode("find");
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
