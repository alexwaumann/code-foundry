import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import type { FileReadView } from "@/api/files";

const { openFileInPanel } = vi.hoisted(() => ({ openFileInPanel: vi.fn<(target: string, file: object) => boolean>(() => true) }));
vi.mock("@/stores/filePanel", () => ({ openFileInPanel }));

const CF = "/Users/dev/src/code-foundry";
const HELLO = "<!doctype html>\n<h1 id=hello>Hello</h1>\n<button id=wave>Wave</button>\n";

// The daemon's file reads: hello.html is there (a grant, its source), gone.html is not.
vi.mock("@/api/files", async (orig) => {
  const read = (path: string): FileReadView => {
    const there = path.endsWith("hello.html");
    return { path: `${CF}/${path}`, size: there ? HELLO.length : 0, truncated: false, binary: false, mime: there ? "text/html" : "", modifiedAtMs: null, notFound: !there, isDir: false, text: there ? HELLO : null } as FileReadView;
  };
  return {
    ...(await orig<typeof import("@/api/files")>()),
    readFile: (_base: string, path: string) => Promise.resolve(read(path)),
    statFile: () => Promise.resolve(""),
    previewFile: (_base: string, path: string) =>
      path.endsWith("hello.html") ? Promise.resolve({ url: `http://127.0.0.1:1/preview/g/${path}`, scope: CF, singleFile: false }) : Promise.reject(new ConnectError(`${CF}/${path} does not exist`, Code.NotFound)),
  };
});

const { buildRows, buildTurns, decodeTimelineKey, timelineKey } = await import("@/lib/threadTimeline");
const { forgetTurnView, structOf, useThreadStore } = await import("@/stores/thread");
const { useThreadsStore } = await import("@/stores/threads");
const { thread } = await import("@/test/projectsWorld");
const { ThreadContext } = await import("./context");
const { PaneOverlay } = await import("./InlineHtml");
const { TimelineRowView } = await import("./rows");

/**
 * Inline pages (docs/notes/inline-html.md) over the mock's s-r1 in its "html" state: a working
 * turn showing docs/hello.html (renders) and docs/gone.html (missing). The frame's document,
 * its scripts and its size are e2e/inline-html.spec.ts's.
 */

const base = { parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false };
const TURN: ThreadItemView[] = [
  { ...base, id: "u", ordinal: 1, kind: "user", text: "Show me a small page that says hello with a button, inline.", attachments: [], composerText: "" },
  { ...base, id: "w", ordinal: 2, kind: "tool", toolUseId: "w", name: "Write", inputJson: JSON.stringify({ file_path: `${CF}/docs/hello.html` }), status: "done", output: "", isError: false, resultJson: "" },
  { ...base, id: "h1", ordinal: 3, kind: "html", path: "docs/hello.html", title: "", baseDir: CF },
  { ...base, id: "t1", ordinal: 4, kind: "text", text: "Here it is: a heading and a Wave button." },
  { ...base, id: "h2", ordinal: 5, kind: "html", path: "docs/gone.html", title: "An older page", baseDir: CF },
  { ...base, id: "t2", ordinal: 6, kind: "text", text: "That second one was deleted since, so it cannot be shown." },
];
const END: ThreadItemView = {
  ...base,
  id: "e",
  ordinal: 7,
  kind: "turnEnd",
  subtype: "success",
  isError: false,
  interrupted: false,
  stopReason: "",
  terminalReason: "",
  durationMs: 3000,
  numTurns: 1,
  costUsd: 0,
  turnCostUsd: null,
  model: "",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  errors: [],
};

/** The thread's rows in the pane's overlay scope, as ThreadBody renders them. */
function Pane({ items, working }: { items: ThreadItemView[]; working: boolean }) {
  const folds = useThreadStore((s) => s.folds["s-r1"]);
  const rows = buildRows(buildTurns(items.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: (k) => folds?.[k], working });
  return (
    <ThreadContext.Provider value={{ threadId: "s-r1", cwd: CF }}>
      <div data-testid="thread-pane-body">
        <PaneOverlay scope="s-r1" threadId="s-r1">
          <div data-testid="thread-timeline">
            {rows.map((r) => (
              <TimelineRowView key={r.key} row={r} />
            ))}
          </div>
        </PaneOverlay>
      </div>
    </ThreadContext.Provider>
  );
}

function publish(items: ThreadItemView[]): void {
  useThreadStore.setState((s) => ({ logs: { ...s.logs, "s-r1": { seq: items.length, byId: Object.fromEntries(items.map((it) => [it.id, it])), order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents: [] } } }));
}

function mount(items = TURN, working = true) {
  publish(items);
  return render(<Pane items={items} working={working} />);
}

const page = (name: string) => {
  const el = screen.getAllByTestId("thread-html").find((h) => h.textContent.includes(name));
  if (!el) throw new Error(`no ${name}`);
  return el;
};
const card = (name: string) => within(page(name)).queryByTestId("thread-html-card");
const rowOf = (name: string) => within(page(name)).getByTestId("thread-html-row");
const header = () => screen.getByTestId("thread-turn-header");

beforeEach(() => {
  useThreadsStore.setState({ byId: { "s-r1": thread("s-r1", { state: "connected", status: "busy" }) }, order: ["s-r1"] });
});

afterEach(() => {
  cleanup();
  openFileInPanel.mockClear();
  useThreadStore.setState({ logs: {}, expanded: {}, folds: {}, pageModals: {} });
});

describe("an inline page's card", () => {
  it("renders the page in its frame; Source swaps the frame for the file's code and back", async () => {
    mount();
    const c = () => card("hello.html") as HTMLElement;
    expect(await within(c()).findByTestId("thread-html-frame")).toBeTruthy();
    const toggle = within(c()).getByTestId("thread-html-source-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(within(c()).queryByTestId("thread-html-frame")).toBeNull();
    const source = within(c()).getByTestId("thread-html-source");
    // The file's code view (its lines render in @pierre/diffs' shadow root: e2e/file-tabs.spec.ts).
    await vi.waitFor(() => {
      expect(source.querySelector('[data-testid="file-code"] diffs-container')).not.toBeNull();
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Show the page");
    fireEvent.click(toggle);
    expect(within(c()).queryByTestId("thread-html-source")).toBeNull();
    expect(within(c()).getByTestId("thread-html-frame")).toBeTruthy();
  });

  it("a page that cannot be rendered says so and why, never a blank box; its source cannot be read either", async () => {
    mount();
    expect(rowOf("gone.html").textContent).toContain("An older page");
    const c = card("gone.html") as HTMLElement;
    const failed = await within(c).findByTestId("thread-html-failed");
    expect(failed.textContent).toContain("Could not render this page.");
    expect(failed.textContent).toContain("does not exist");
    expect(within(c).queryByTestId("thread-html-frame")).toBeNull();
    expect((await within(c).findByText(/The source cannot be read either/)).textContent).toContain("no file at");
    // Source has nothing to switch to.
    expect(within(c).getByTestId("thread-html-source-toggle").getAttribute("aria-disabled")).toBe("true");
  });

  it("open in side panel opens the file in the thread's own panel", () => {
    mount();
    fireEvent.click(within(card("hello.html") as HTMLElement).getByTestId("thread-html-panel"));
    expect(openFileInPanel).toHaveBeenCalledWith("thread:s-r1", { project: "repo-cf", base: CF, path: `${CF}/docs/hello.html` });
  });
});

describe("the turn's fold never touches a page", () => {
  it("the turn ends while the reader watches: folded, both cards open; the fold keeps them; only the row closes and opens one; leaving the thread forgets that", () => {
    const view = mount();
    expect(screen.getAllByTestId("thread-html-card")).toHaveLength(2);
    // The turn ends.
    act(() => {
      publish([...TURN, END]);
    });
    view.rerender(<Pane items={[...TURN, END]} working={false} />);
    expect(header().getAttribute("data-folded")).toBe("true");
    expect(screen.getAllByTestId("thread-html")).toHaveLength(2);
    expect(screen.getAllByTestId("thread-html-card")).toHaveLength(2);
    // Unfold, fold: the cards stay open, no row says folded.
    fireEvent.click(screen.getByRole("button", { name: "Show this turn's work" }));
    expect(screen.getAllByTestId("thread-html-card")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Hide this turn's work" }));
    expect(screen.getAllByTestId("thread-html-card")).toHaveLength(2);
    expect(rowOf("hello.html").getAttribute("aria-expanded")).toBe("true");
    expect(rowOf("hello.html").textContent).not.toContain("folded");
    // The row closes it; the turn's fold does not open it again.
    fireEvent.click(rowOf("hello.html"));
    expect(card("hello.html")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show this turn's work" }));
    expect(card("hello.html")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide this turn's work" }));
    expect(card("hello.html")).toBeNull();
    fireEvent.click(rowOf("hello.html"));
    expect(card("hello.html")).not.toBeNull();
    fireEvent.click(rowOf("hello.html"));
    expect(card("hello.html")).toBeNull();
    // Leaving the thread (ThreadPane's WatchedThread) forgets the choice: open again on return.
    view.unmount();
    act(() => {
      forgetTurnView("s-r1");
    });
    mount([...TURN, END], false);
    expect(header().getAttribute("data-folded")).toBe("true");
    expect(screen.getAllByTestId("thread-html-card")).toHaveLength(2);
  });
});

describe("the open page (Expand)", () => {
  it("is kept per pane scope: away and back it is up again as it was, Close focused, the card under it without a frame; closing forgets it", async () => {
    const view = mount();
    fireEvent.click(within(card("hello.html") as HTMLElement).getByTestId("thread-html-expand"));
    const box = () => screen.getByTestId("thread-html-lightbox");
    expect(document.activeElement).toBe(within(box()).getByTestId("thread-html-close"));
    expect(await within(box()).findByTestId("thread-html-lightbox-frame")).toBeTruthy();
    fireEvent.click(within(box()).getByTestId("thread-html-source-toggle"));
    expect(within(box()).getByTestId("thread-html-source")).toBeTruthy();
    // Another thread shown: this pane goes (its modal with it).
    view.unmount();
    expect(screen.queryByTestId("thread-html-lightbox")).toBeNull();
    // Back: up again, its source showing, Close focused.
    mount();
    expect(within(box()).getByTestId("thread-html-path").textContent).toBe("docs/hello.html");
    expect(await within(box()).findByTestId("thread-html-source")).toBeTruthy();
    expect(document.activeElement).toBe(within(box()).getByTestId("thread-html-close"));
    fireEvent.click(within(box()).getByTestId("thread-html-source-toggle"));
    expect(await within(box()).findByTestId("thread-html-lightbox-frame")).toBeTruthy();
    // The modal's frame is the file's one: the card has none.
    expect(within(card("hello.html") as HTMLElement).getByTestId("thread-html-covered")).toBeTruthy();
    expect(screen.queryByTestId("thread-html-frame")).toBeNull();
    // Escape closes it, and closing forgets it: away and back, no modal.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("thread-html-lightbox")).toBeNull();
    cleanup();
    mount();
    expect(screen.getAllByTestId("thread-html")).toHaveLength(2);
    expect(screen.queryByTestId("thread-html-lightbox")).toBeNull();
  });
});
