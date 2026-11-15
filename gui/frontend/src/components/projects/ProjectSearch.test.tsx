import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncludeSuggestionsView } from "@/api/filesystem";

/**
 * A project page's Search section (docs/notes/file-search-2-includes-gui.md): the effective
 * include patterns, removing at both levels, the add field's two scopes, refusals in place,
 * and the suggestions. The project's list is the fake daemon's project.files.include (which
 * publishes the project as the daemon's event does); the setting's is the settings store,
 * whose save lands at once.
 */
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify, notifyProgress: vi.fn(), dismissNotice: vi.fn() }));
const save = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/stores/settings", async (orig) => {
  const m = await orig<typeof import("@/stores/settings")>();
  save.fn.mockImplementation((values: Record<string, string>) => {
    const cur = m.useSettingsStore.getState().snapshot;
    if (cur) m.useSettingsStore.setState({ snapshot: { ...cur, values: { ...cur.values, ...values }, revision: cur.revision + 1 } });
    return Promise.resolve({ ok: true as const });
  });
  return { ...m, saveSettings: save.fn };
});

const { ProjectSearch } = await import("./ProjectSearch");
const { daemon, lastInvocation, resetDaemon } = await import("@/test/daemonFakes");
const { seedWorld, updateProject } = await import("@/test/projectsWorld");
const { useSettingsStore } = await import("@/stores/settings");
const { SUGGEST_DEBOUNCE_MS } = await import("@/components/includes/useIncludeSuggestions");

const KEY = "files.include_ignored";
const REFUSED = 'pattern "../x" has a ".." segment; patterns name paths inside the project';

const suggest = vi.fn<(req: { projectId: string; text: string; limit?: number }) => Promise<IncludeSuggestionsView>>();
const NOTHING: IncludeSuggestionsView = { suggestions: [], textFiles: 0, textFilesCapped: false, textError: "" };

beforeEach(() => {
  resetDaemon();
  seedWorld();
  notify.mockClear();
  save.fn.mockClear();
  suggest.mockReset();
  suggest.mockResolvedValue(NOTHING);
  useSettingsStore.setState({ snapshot: { values: { [KEY]: ".env*, CLAUDE.local.md" }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
  updateProject("repo-cf", (p) => ({ ...p, includeIgnored: ["docs/scratch/", ".env*"] }));
  // The daemon's project.files.include: refuses ../, else sets the list and publishes the project.
  daemon.handlers.set("project.files.include", (inv) => {
    const v = inv.args.patterns ?? "";
    if (v.includes("../")) throw new ConnectError(`invalid argument: ${REFUSED}`, Code.InvalidArgument);
    updateProject(inv.args.project ?? "", (p) => ({ ...p, includeIgnored: v === "none" ? [] : v.split(", ") }));
    return { message: "", resultJson: "" };
  });
});
afterEach(cleanup);

const view = () => render(<ProjectSearch projectId="repo-cf" suggest={(req) => suggest(req)} />);
/** Each row as "pattern [badge]". */
const rows = () => screen.queryAllByTestId("include-row").map((r) => [r.dataset.pattern, r.querySelector('[data-testid="include-badge"]')?.textContent].filter(Boolean).join(" "));
const field = () => screen.getByTestId<HTMLInputElement>("include-add-input");
const setting = () => useSettingsStore.getState().snapshot?.values[KEY];

async function settled(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function type(text: string): Promise<void> {
  fireEvent.change(field(), { target: { value: text } });
  await settled(SUGGEST_DEBOUNCE_MS + 10);
}

async function press(opts: { key: string; metaKey?: boolean }): Promise<void> {
  fireEvent.keyDown(field(), opts);
  await settled();
}

describe("the Search section's list", () => {
  it("lists the setting's patterns first, badged all projects, then the project's own; a repeat once", () => {
    view();
    expect(screen.getByText("Search")).toBeTruthy();
    expect(rows()).toEqual([".env* all projects", "CLAUDE.local.md all projects", "docs/scratch/"]);
  });

  it("× on the project's own pattern runs project.files.include with the rest, in the project's context", async () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Remove docs/scratch/" }));
    await settled();
    const inv = lastInvocation("project.files.include");
    expect(inv?.args).toEqual({ project: "repo-cf", patterns: ".env*" });
    expect(inv?.context).toMatchObject({ activeProjectId: "repo-cf" });
    expect(save.fn).not.toHaveBeenCalled();
  });

  it("removing the project's last pattern sends none", async () => {
    updateProject("repo-cf", (p) => ({ ...p, includeIgnored: ["docs/scratch/"] }));
    view();
    fireEvent.click(screen.getByRole("button", { name: "Remove docs/scratch/" }));
    await settled();
    expect(lastInvocation("project.files.include")?.args.patterns).toBe("none");
    expect(rows()).toEqual([".env* all projects", "CLAUDE.local.md all projects"]);
  });

  it("× on an all-projects pattern edits the setting (for every project), not the project's list", async () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Remove CLAUDE.local.md" }));
    await settled();
    expect(save.fn).toHaveBeenCalledWith({ [KEY]: ".env*" });
    expect(lastInvocation("project.files.include")).toBeUndefined();
    expect(rows()).toEqual([".env* all projects", "docs/scratch/"]);
  });

  it("removing the setting's last pattern stores none", async () => {
    useSettingsStore.setState({ snapshot: { values: { [KEY]: "CLAUDE.local.md" }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
    view();
    fireEvent.click(screen.getByRole("button", { name: "Remove CLAUDE.local.md" }));
    await settled();
    expect(save.fn).toHaveBeenCalledWith({ [KEY]: "none" });
  });
});

describe("the add field", () => {
  it("Enter adds the typed pattern to this project and clears; cmd+Enter adds it for all projects; no success toast", async () => {
    view();
    fireEvent.focus(field());
    await type("*.log");
    await press({ key: "Enter" });
    expect(lastInvocation("project.files.include")?.args).toEqual({ project: "repo-cf", patterns: "docs/scratch/, .env*, *.log" });
    expect(field().value).toBe("");
    await type("build/");
    await press({ key: "Enter", metaKey: true });
    expect(save.fn).toHaveBeenCalledWith({ [KEY]: ".env*, CLAUDE.local.md, build/" });
    expect(setting()).toBe(".env*, CLAUDE.local.md, build/");
    expect(rows().at(2)).toBe("build/ all projects");
    expect(field().value).toBe("");
    // The list shows both; neither is toasted.
    expect(notify).not.toHaveBeenCalled();
  });

  it("a pattern every project already includes is not added to the project", async () => {
    view();
    await type("CLAUDE.local.md");
    await press({ key: "Enter" });
    expect(lastInvocation("project.files.include")).toBeUndefined();
    expect(field().value).toBe("");
  });

  it("a refused pattern shows the daemon's message in place (no toast) and keeps the text", async () => {
    view();
    await type("../x");
    await press({ key: "Enter" });
    expect(screen.getByTestId("include-error").textContent).toBe(REFUSED);
    expect(field().value).toBe("../x");
    expect(notify).not.toHaveBeenCalled();
  });

  it("a comma is refused before anything is sent", async () => {
    view();
    await type("a, b");
    await press({ key: "Enter" });
    expect(lastInvocation("project.files.include")).toBeUndefined();
    expect(screen.getByTestId("include-error").textContent).toBe('pattern "a, b" has a comma, which separates patterns');
  });
});

describe("suggestions", () => {
  const ENTRIES: IncludeSuggestionsView = {
    suggestions: [
      { path: ".env", isDir: false, fileCount: 0, fileCountCapped: false, included: true, pathPositions: [] },
      { path: "gui/frontend/test-results", isDir: true, fileCount: 212, fileCountCapped: false, included: false, pathPositions: [] },
      { path: "node_modules", isDir: true, fileCount: 1000, fileCountCapped: true, included: false, pathPositions: [] },
    ],
    textFiles: 0,
    textFilesCapped: false,
    textError: "",
  };
  /** Each suggestion as "path | note", the selected one starred, bold letters in [brackets]. */
  const suggestions = () =>
    screen.queryAllByTestId("include-suggestion").map((s) => {
      const path = Array.from(s.querySelector("code")?.childNodes ?? [])
        .map((n) => (n instanceof Element && n.tagName === "B" ? `[${n.textContent}]` : (n.textContent ?? "")))
        .join("");
      return `${s.getAttribute("aria-selected") === "true" ? "*" : ""}${path} | ${s.querySelector('[data-testid="include-suggestion-note"]')?.textContent ?? ""}`;
    });

  it("focus asks for the project's ignored entries and lists them: counts, included marked, the first pickable picked; Enter adds it as a folder", async () => {
    suggest.mockResolvedValue(ENTRIES);
    view();
    fireEvent.focus(field());
    await settled(SUGGEST_DEBOUNCE_MS + 10);
    expect(suggest).toHaveBeenLastCalledWith({ projectId: "repo-cf", text: "", limit: 20 });
    expect(await screen.findByTestId("include-suggestions")).toBeTruthy();
    expect(suggestions()).toEqual([".env | included", "*gui/frontend/test-results/ | 212 files", "node_modules/ | 1,000+ files"]);
    expect(screen.getByTestId("include-hints").textContent).toBe("⏎ add to this project⌘⏎ add for all projects");
    await press({ key: "Enter" });
    expect(lastInvocation("project.files.include")?.args.patterns).toBe("docs/scratch/, .env*, gui/frontend/test-results/");
  });

  it("↑↓ skip included entries; cmd+Enter adds the pick for all projects", async () => {
    suggest.mockResolvedValue(ENTRIES);
    view();
    fireEvent.focus(field());
    await settled(SUGGEST_DEBOUNCE_MS + 10);
    await screen.findByTestId("include-suggestions");
    await press({ key: "ArrowDown" });
    expect(suggestions()[2]).toBe("*node_modules/ | 1,000+ files");
    await press({ key: "ArrowDown" });
    expect(suggestions()[1]).toBe("*gui/frontend/test-results/ | 212 files");
    await press({ key: "Enter", metaKey: true });
    expect(save.fn).toHaveBeenCalledWith({ [KEY]: ".env*, CLAUDE.local.md, gui/frontend/test-results/" });
  });

  it("typed text that begins a suggestion's path picks it, so Enter adds the entry", async () => {
    suggest.mockImplementation((req) =>
      Promise.resolve(req.text === "" ? ENTRIES : { suggestions: [{ path: "docs/drafts", isDir: true, fileCount: 2, fileCountCapped: false, included: false, pathPositions: [0, 1, 2, 3, 4, 5, 6] }], textFiles: 0, textFilesCapped: false, textError: "" }),
    );
    view();
    fireEvent.focus(field());
    await type("docs/dr");
    expect(suggestions()).toEqual(["*[docs/dr]afts/ | 2 files"]);
    expect(screen.getByTestId("include-text-count").textContent).toBe("matches 0 files");
    await press({ key: "Enter" });
    expect(lastInvocation("project.files.include")?.args.patterns).toBe("docs/scratch/, .env*, docs/drafts/");
  });

  it("typed text no suggestion begins (a glob): the matched letters bold, its own count in the field, nothing picked so Enter adds the text; ↓ picks a suggestion", async () => {
    suggest.mockImplementation((req) =>
      Promise.resolve(
        req.text === ""
          ? ENTRIES
          : { suggestions: [{ path: "gui/frontend/test-results", isDir: true, fileCount: 212, fileCountCapped: false, included: false, pathPositions: [13, 14, 15, 16] }], textFiles: 0, textFilesCapped: false, textError: "" },
      ),
    );
    view();
    fireEvent.focus(field());
    await type("*test*");
    expect(suggest).toHaveBeenLastCalledWith({ projectId: "repo-cf", text: "*test*", limit: 20 });
    expect(suggestions()).toEqual(["gui/frontend/[test]-results/ | 212 files"]);
    expect(screen.getByTestId("include-text-count").textContent).toBe("matches 0 files");
    await press({ key: "ArrowDown" });
    expect(suggestions()).toEqual(["*gui/frontend/[test]-results/ | 212 files"]);
    await press({ key: "ArrowUp" });
    expect(suggestions()).toEqual(["gui/frontend/[test]-results/ | 212 files"]);
    await press({ key: "Enter" });
    expect(lastInvocation("project.files.include")?.args.patterns).toBe("docs/scratch/, .env*, *test*");
  });

  it("the sketch's case: gui/frontend/test begins gui/frontend/test-results/, picked, with the text's count", async () => {
    suggest.mockResolvedValue({ suggestions: [{ path: "gui/frontend/test-results", isDir: true, fileCount: 212, fileCountCapped: false, included: false, pathPositions: [13, 14, 15, 16] }], textFiles: 212, textFilesCapped: false, textError: "" });
    view();
    fireEvent.focus(field());
    await type("gui/frontend/test");
    expect(suggestions()).toEqual(["*gui/frontend/[test]-results/ | 212 files"]);
    expect(screen.getByTestId("include-text-count").textContent).toBe("matches 212 files");
  });

  it("an invalid typed pattern shows why under the field and no count", async () => {
    suggest.mockResolvedValue({ ...NOTHING, textError: 'pattern "~/x" starts with ~: patterns are relative to the project folder' });
    view();
    fireEvent.focus(field());
    await type("~/x");
    expect(screen.getByTestId("include-error").textContent).toBe('pattern "~/x" starts with ~: patterns are relative to the project folder');
    expect(screen.queryByTestId("include-text-count")).toBeNull();
  });

  it("Escape closes the suggestions, then clears the text", async () => {
    suggest.mockResolvedValue(ENTRIES);
    view();
    fireEvent.focus(field());
    await type("x");
    await screen.findByTestId("include-suggestions");
    fireEvent.keyDown(field(), { key: "Escape" });
    await settled();
    expect(screen.queryByTestId("include-suggestions")).toBeNull();
    expect(field().value).toBe("x");
    fireEvent.keyDown(field(), { key: "Escape" });
    await settled();
    expect(field().value).toBe("");
  });

  it("a failed ask says so in the popover", async () => {
    suggest.mockRejectedValue(new ConnectError("project repo-cf is not a git repository", Code.FailedPrecondition));
    view();
    fireEvent.focus(field());
    await settled(SUGGEST_DEBOUNCE_MS + 10);
    expect(within(await screen.findByTestId("include-suggestions")).getByTestId("include-suggest-error").textContent).toBe("Cannot list ignored files: project repo-cf is not a git repository");
  });
});
