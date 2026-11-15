// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CommandView } from "@/api/command";
import { blankFile, type FileReadView } from "@/api/files";
import type { FinderSourceView } from "@/api/filesystem";
import type { TextFileView, TextQueryView, TextSummaryView } from "@/api/textSearch";
import { handleKeyDown, presentCommand } from "@/keys/bindings";
import { TEXT_DEBOUNCE_MS, TEXT_PREVIEW_DEBOUNCE_MS } from "@/lib/textSearch";
import { registerCiteTarget } from "@/stores/cite";
import { useCommandsStore } from "@/stores/commands";
import { useFileFindStore } from "@/stores/fileFind";
import { useRecentFilesStore } from "@/stores/recentFiles";
import { useUiStore } from "@/stores/ui";
import { stubLayout, settle } from "@/test/composerWorld";
import { resetDaemon } from "@/test/daemonFakes";
import { layoutSettled, threadSeed } from "@/test/fakeLayout";
import { addThreads, CF, GP, panelActive, resetPanels, seedWorld, thread } from "@/test/projectsWorld";
import { CommandPalette } from "./CommandPalette";

// jsdom lays nothing out, so TanStack Virtual would render no rows: every row at its estimated size.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (o: { count: number; estimateSize: (i: number) => number; getItemKey: (i: number) => string | number }) => {
    const items: { index: number; key: string | number; start: number; size: number; end: number }[] = [];
    let at = 0;
    for (let i = 0; i < o.count; i++) {
      const size = o.estimateSize(i);
      items.push({ index: i, key: o.getItemKey(i), start: at, size, end: at + size });
      at += size;
    }
    return { getVirtualItems: () => items, getTotalSize: () => at, measure: () => undefined, scrollToIndex: () => undefined, scrollToOffset: () => undefined };
  },
}));

type Req = { sources: readonly FinderSourceView[] } & TextQueryView;
interface Stream {
  req: Req;
  onFiles: (files: TextFileView[]) => void;
  signal: AbortSignal | undefined;
  end: (s: Partial<TextSummaryView>) => void;
  fail: (err: unknown) => void;
}
const streams: Stream[] = [];
const read = vi.fn<(checkout: string, path: string) => Promise<FileReadView>>();

vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));
vi.mock("@/api/textSearch", async (orig) => ({
  ...(await orig<typeof import("@/api/textSearch")>()),
  searchText: (req: Req, onFiles: (f: TextFileView[]) => void, signal?: AbortSignal) =>
    new Promise<TextSummaryView>((resolve, reject) => {
      streams.push({ req, onFiles, signal, end: (s) => {
        resolve({ lines: 0, files: 0, truncated: false, fileCapped: false, totalCapped: false, timedOut: false, caseSensitive: false, elapsedMs: 1, includedCapped: false, ...s });
      }, fail: reject });
    }),
}));
vi.mock("@/api/files", async (orig) => ({ ...(await orig<typeof import("@/api/files")>()), readFile: (base: string, path: string) => read(base, path) }));
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), ...(await import("@/test/daemonFakes")).detailFakes }));
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

const FILE_FIND: CommandView = { name: "file.find", title: "Go to File…", description: "", category: "View", args: [], keybindings: ["cmd+p"], available: true };
const FILE_FIND_TEXT: CommandView = { name: "file.find.text", title: "Search in Files…", description: "", category: "View", args: [], keybindings: ["cmd+shift+p"], available: true };

function tf(path: string, lines: [number, string, [number, number][]][], o: Partial<TextFileView> = {}): TextFileView {
  return { projectId: "repo-cf", checkout: CF, path, ignored: false, lines: lines.map(([line, text, r]) => ({ line, text, ranges: r.map(([start, end]) => ({ start, end })), cutStart: false, cutEnd: false })), lineCount: lines.length, lineCountCapped: false, ...o };
}

const PATHS = tf("internal/daemon/paths.go", [
  [18, "// Home: $CODE_FOUNDRY_HOME, else ~/.code-foundry.", [[10, 27]]],
  [24, '\tif h := os.Getenv("CODE_FOUNDRY_HOME"); h != "" {', [[20, 37]]],
]);
const ENV = tf(".env.local", [[3, "CODE_FOUNDRY_HOME=/tmp/cf", [[0, 17]]]], { ignored: true });

beforeEach(async () => {
  stubLayout();
  resetDaemon();
  seedWorld();
  await resetPanels(threadSeed("s-1"));
  streams.length = 0;
  read.mockReset();
  read.mockImplementation((base, path) => Promise.resolve({ ...blankFile(`${base}/${path}`), text: "x\n".repeat(17) + "// Home: $CODE_FOUNDRY_HOME, else ~/.code-foundry.\n" }));
  useRecentFilesStore.setState({ byKey: {} });
  useCommandsStore.setState({ commands: [FILE_FIND, FILE_FIND_TEXT], loading: false, error: null, contextKey: "" });
  addThreads(thread("s-two", { projectId: "repo-gp", projectIds: ["repo-gp", "repo-cf"], worktreePath: GP, checkoutPaths: [{ projectId: "repo-cf", path: CF }] }));
  render(<CommandPalette />);
});

afterEach(() => {
  cleanup();
  act(() => {
    useUiStore.getState().closePalette();
  });
});

async function openText(threadId = "s-1"): Promise<void> {
  act(() => {
    useUiStore.getState().select({ kind: "thread", id: threadId });
  });
  act(() => {
    presentCommand("file.find.text");
  });
  await settle(10);
}

const field = () => screen.getByTestId("finder-input");
const mode = () => screen.queryByTestId("palette")?.getAttribute("data-mode") ?? null;
function type(q: string) {
  fireEvent.change(field(), { target: { value: q } });
}
/** Past the debounce: the stream is out. */
async function debounced(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, TEXT_DEBOUNCE_MS + 20));
  });
}
async function send(s: Stream, files: TextFileView[]): Promise<void> {
  await act(async () => {
    s.onFiles(files);
    await Promise.resolve();
  });
}
async function end(s: Stream, summary: Partial<TextSummaryView> = {}): Promise<void> {
  await act(async () => {
    s.end(summary);
    await new Promise((r) => setTimeout(r, 0));
  });
}
const last = () => streams.at(-1) as Stream;
/** Rows as "F name" / "M line text" / "N note", the selected match with "*". */
function rows(): string[] {
  return screen.queryAllByTestId("text-row").map((r) => {
    const kind = r.getAttribute("data-kind");
    if (kind === "file") return `F ${r.querySelector('[data-testid="text-file-name"]')?.textContent ?? ""}`;
    if (kind === "more") return `N ${r.textContent}`;
    const marks = Array.from(r.querySelectorAll("mark")).map((m) => m.textContent);
    return `M${r.hasAttribute("data-selected") ? "*" : ""} ${r.getAttribute("data-line") ?? ""} [${marks.join("|")}]`;
  });
}
const key = (k: string, o: KeyboardEventInit = {}) => {
  fireEvent.keyDown(field(), { key: k, ...o });
};

describe("opening Text mode", () => {
  it("file.find.text opens the finder in Text mode, wide, the field focused", async () => {
    await openText();
    expect(mode()).toBe("text");
    expect(field().getAttribute("placeholder")).toBe("Search text in code-foundry…");
    expect(document.activeElement).toBe(field());
    expect(document.querySelector('[data-region="palette"]')?.className).toContain("w-[min(1000px");
    expect(screen.getByTestId("text-hint").textContent).toContain("A capital letter matches case.");
  });

  it("cmd+shift+p runs file.find.text through the keymap, not the command palette", async () => {
    act(() => {
      useUiStore.getState().select({ kind: "thread", id: "s-1" });
    });
    act(() => {
      handleKeyDown(new KeyboardEvent("keydown", { key: "p", code: "KeyP", metaKey: true, shiftKey: true, bubbles: true }));
    });
    await settle(10);
    expect(useUiStore.getState().palette.page).toBe("files");
    expect(mode()).toBe("text");
  });

  it("Tab and the switch change the mode and keep the query; Files mode stays narrow", async () => {
    await openText();
    type("render");
    key("Tab");
    expect(mode()).toBe("files");
    expect(screen.getByRole("combobox")).toHaveProperty("value", "render");
    expect(document.querySelector('[data-region="palette"]')?.className).toContain("max-w-xl");
    expect(screen.getByTestId("finder-hints").textContent).toContain("tab search text");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Tab" });
    expect(mode()).toBe("text");
    expect((field() as HTMLInputElement).value).toBe("render");
    expect(screen.getByTestId("text-hints").textContent).toContain("search files");
    fireEvent.click(screen.getByTestId("finder-mode-files"));
    expect(mode()).toBe("files");
  });
});

describe("searching", () => {
  it("sends nothing under two characters", async () => {
    await openText();
    type("a");
    await debounced();
    expect(streams).toHaveLength(0);
    expect(screen.getByTestId("text-hint").textContent).toBe("Type at least 2 characters.");
  });

  it("streams files into groups as they arrive, the summary ends it, the status counts", async () => {
    await openText();
    type("CODE_FOUNDRY_HOME");
    await debounced();
    expect(last().req).toEqual({ sources: [{ projectId: "repo-cf", path: CF }], query: "CODE_FOUNDRY_HOME", matchCase: false, wholeWord: false, regex: false });
    expect(screen.getByTestId("text-searching")).toBeTruthy();
    await send(last(), [PATHS]);
    expect(rows()).toEqual(["F paths.go", "M* 18 [CODE_FOUNDRY_HOME]", "M 24 [CODE_FOUNDRY_HOME]"]);
    expect(screen.getByTestId("text-status").textContent).toBe("Searching… 2 matches in 1 file");
    await send(last(), [ENV]);
    expect(rows()).toEqual(["F paths.go", "M* 18 [CODE_FOUNDRY_HOME]", "M 24 [CODE_FOUNDRY_HOME]", "F .env.local", "M 3 [CODE_FOUNDRY_HOME]"]);
    expect(screen.getAllByTestId("text-file-ignored")).toHaveLength(1);
    await end(last(), { lines: 3, files: 2, caseSensitive: true });
    expect(screen.getByTestId("text-status").textContent).toBe("3 matches in 2 files");
  });

  it("says when a file's lines were capped, and the search's notes", async () => {
    await openText();
    type("the");
    await debounced();
    await send(last(), [{ ...PATHS, lineCount: 999, lineCountCapped: true }]);
    await end(last(), { truncated: true, totalCapped: true, fileCapped: true });
    expect(rows().at(-1)).toBe("N 997+ more in this file");
    expect(screen.getByTestId("text-status").textContent).toBe("999+ matches in 1 file · stopped at 2,000 lines");
  });

  it("a newer query aborts the stream out; the old rows stay until the new search's first message", async () => {
    await openText();
    type("CODE_FOUNDRY");
    await debounced();
    const first = last();
    await send(first, [PATHS]);
    type("CODE_FOUNDRY_HOME");
    expect(first.signal?.aborted).toBe(true);
    await debounced();
    expect(rows()[0]).toBe("F paths.go");
    await send(last(), [ENV]);
    expect(rows()).toEqual(["F .env.local", "M* 3 [CODE_FOUNDRY_HOME]"]);
  });

  it("no match says so", async () => {
    await openText();
    type("zqxj");
    await debounced();
    await end(last());
    expect(screen.getByTestId("text-none").textContent).toBe("No matches for “zqxj”.");
  });

  it("closing the finder or leaving Text mode aborts the stream", async () => {
    await openText();
    type("CODE");
    await debounced();
    const s = last();
    key("Tab");
    expect(s.signal?.aborted).toBe(true);
    key("Tab");
    await debounced();
    act(() => {
      useUiStore.getState().closePalette();
    });
    await settle(5);
    expect(last().signal?.aborted).toBe(true);
  });
});

describe("toggles and case", () => {
  it("each toggle (click or ⌥ key) sends its option and searches again", async () => {
    await openText();
    type("needle");
    await debounced();
    fireEvent.click(screen.getByTestId("text-whole-word"));
    await debounced();
    expect(last().req).toMatchObject({ wholeWord: true, matchCase: false, regex: false });
    key("r", { code: "KeyR", altKey: true });
    await debounced();
    expect(last().req).toMatchObject({ wholeWord: true, regex: true });
    key("c", { code: "KeyC", altKey: true });
    await debounced();
    expect(last().req).toMatchObject({ matchCase: true });
    expect(screen.getByTestId("text-match-case").getAttribute("aria-pressed")).toBe("true");
  });

  it("Aa shows on while the daemon's summary says smart case matched case", async () => {
    await openText();
    type("Home");
    await debounced();
    expect(screen.getByTestId("text-match-case").getAttribute("aria-pressed")).toBe("false");
    await end(last(), { caseSensitive: true });
    expect(screen.getByTestId("text-match-case").getAttribute("aria-pressed")).toBe("true");
    expect(last().req.matchCase).toBe(false);
  });

  it("an invalid regex shows the daemon's reason by the field, not in the list", async () => {
    await openText();
    fireEvent.click(screen.getByTestId("text-regex"));
    type("(needle");
    await debounced();
    await act(async () => {
      last().fail(new ConnectError("invalid regular expression: unclosed group", Code.InvalidArgument));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("text-query-error").textContent).toBe("invalid regular expression: unclosed group");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByTestId("text-error")).toBeNull();
  });

  it("ripgrep missing shows its own sentence", async () => {
    await openText();
    type("needle");
    await debounced();
    await act(async () => {
      last().fail(new ConnectError("text search is unavailable: ripgrep is missing; update or reinstall Code Foundry to restore it", Code.FailedPrecondition));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("text-error").textContent).toBe("text search is unavailable: ripgrep is missing; update or reinstall Code Foundry to restore it");
  });
});

describe("selection and preview", () => {
  it("arrows (and ctrl+n/p) move over match rows only and wrap", async () => {
    await openText();
    type("CODE_FOUNDRY_HOME");
    await debounced();
    await send(last(), [PATHS, ENV]);
    const selected = () => rows().find((r) => r.startsWith("M*"));
    key("ArrowDown");
    expect(selected()).toBe("M* 24 [CODE_FOUNDRY_HOME]");
    key("n", { ctrlKey: true });
    expect(selected()).toBe("M* 3 [CODE_FOUNDRY_HOME]");
    key("ArrowDown");
    expect(selected()).toBe("M* 18 [CODE_FOUNDRY_HOME]");
    key("p", { ctrlKey: true });
    expect(selected()).toBe("M* 3 [CODE_FOUNDRY_HOME]");
  });

  it("reads the selected file once it rests, shows the match in it, and keeps the read for the finder's life", async () => {
    await openText();
    type("CODE_FOUNDRY_HOME");
    await debounced();
    await send(last(), [PATHS]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, TEXT_PREVIEW_DEBOUNCE_MS + 20));
    });
    expect(read).toHaveBeenCalledWith(CF, "internal/daemon/paths.go");
    expect(screen.getByTestId("text-preview-position").textContent).toBe("match 1 of 2 in this file");
    expect(screen.getByTestId("text-preview-code").getAttribute("data-line")).toBe("18");
    // Line 24 is not in the file as read: the row's own line stands in, with why.
    key("ArrowDown");
    await settle(5);
    expect(screen.getByTestId("text-preview-note").textContent).toBe("The file changed since the search: its line no longer reads like this.");
    key("ArrowUp");
    await settle(5);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("Enter and ⌘⏎", () => {
  it("Enter opens the file at the line with the find bar on a plain query, its first match on that line current", async () => {
    await openText();
    type("CODE_FOUNDRY_HOME");
    await debounced();
    await send(last(), [PATHS]);
    await end(last(), { caseSensitive: true });
    key("ArrowDown");
    key("Enter");
    await settle(5);
    await act(async () => {
      await layoutSettled();
    });
    expect(useUiStore.getState().palette.open).toBe(false);
    expect(panelActive("thread:s-1")?.params).toMatchObject({ path: `${CF}/internal/daemon/paths.go`, line: "24" });
    const sessions = Object.values(useFileFindStore.getState().byTab);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ query: "CODE_FOUNDRY_HOME", current: { line: 23, nth: 0 } });
  });

  it("a regex search opens at the line without the find bar", async () => {
    await openText();
    fireEvent.click(screen.getByTestId("text-regex"));
    type("CODE_[A-Z]+");
    await debounced();
    await send(last(), [PATHS]);
    key("Enter");
    await settle(5);
    await act(async () => {
      await layoutSettled();
    });
    expect(panelActive("thread:s-1")?.params).toMatchObject({ line: "18" });
    expect(Object.keys(useFileFindStore.getState().byTab)).toHaveLength(0);
  });

  it("Enter before the typed query's first answer waits for it and opens its first match", async () => {
    await openText();
    type("CODE_FOUNDRY");
    await debounced();
    await send(last(), [ENV]);
    type("CODE_FOUNDRY_HOME");
    key("Enter");
    expect(useUiStore.getState().palette.open).toBe(true);
    await debounced();
    await send(last(), [PATHS]);
    await settle(5);
    await act(async () => {
      await layoutSettled();
    });
    expect(panelActive("thread:s-1")?.params).toMatchObject({ path: `${CF}/internal/daemon/paths.go`, line: "18" });
  });

  it("an input method's Enter does nothing", async () => {
    await openText();
    type("CODE_FOUNDRY_HOME");
    await debounced();
    await send(last(), [PATHS]);
    fireEvent.keyDown(field(), { key: "Enter", keyCode: 229 });
    await settle(5);
    expect(useUiStore.getState().palette.open).toBe(true);
  });

  it("⌘⏎ puts the file in the prompt at the match's line", async () => {
    const insertTag = vi.fn();
    const unregister = registerCiteTarget("thread:s-1", { insert: () => undefined, insertTag, focus: () => undefined });
    await openText();
    type("CODE_FOUNDRY_HOME");
    await debounced();
    await send(last(), [PATHS]);
    key("ArrowDown");
    key("Enter", { metaKey: true });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(useUiStore.getState().palette.open).toBe(false);
    expect(insertTag).toHaveBeenCalledWith({ tagKind: "file", projectId: "repo-cf", path: "internal/daemon/paths.go", line: 24 });
    unregister();
  });
});
