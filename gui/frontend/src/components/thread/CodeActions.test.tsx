import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { ThreadItemView } from "@/api/thread";

const copyText = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/clipboard", () => ({ copyText }));
const runInThreadTerminal = vi.hoisted(() => vi.fn(() => Promise.resolve("t-new")));
vi.mock("@/stores/bottomActions", () => ({ runInThreadTerminal }));

const { buildRows, buildTurns, decodeTimelineKey, timelineKey } = await import("@/lib/threadTimeline");
const { useCommandsStore } = await import("@/stores/commands");
const { structOf, useThreadStore } = await import("@/stores/thread");
const { ThreadContext } = await import("./context");
const { TimelineRowView } = await import("./rows");
const { ThreadMarkdown } = await import("./Code");

const base = { parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false };
const terminalNew = (available: boolean): CommandView => ({ name: "terminal.new", title: "New Terminal", description: "", category: "Terminal", args: [], keybindings: [], available });

/** A thread `s` with these items, rendered as the timeline renders them, inside `.cf-thread`. */
function show(items: ThreadItemView[]): HTMLElement {
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  useThreadStore.setState({ logs: { s: { seq: 1, byId, order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents: [] } } });
  const rows = buildRows(buildTurns(items.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: () => undefined, working: false });
  return render(
    <div className="cf-thread">
      <ThreadContext.Provider value={{ threadId: "s", cwd: "/w" }}>
        {rows.map((r) => (
          <TimelineRowView key={r.key} row={r} />
        ))}
      </ThreadContext.Provider>
    </div>,
  ).container;
}

function reply(text: string, streaming = false): ThreadItemView[] {
  return [
    { ...base, id: "u", ordinal: 1, kind: "user", text: "go", attachments: [], composerText: "" },
    { ...base, id: "a", ordinal: 2, kind: "text", text, streaming },
  ];
}

beforeEach(() => {
  useCommandsStore.setState({ commands: [terminalNew(true)] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  useThreadStore.setState({ logs: {}, expanded: {}, folds: {} });
  useCommandsStore.setState({ commands: [] });
});

describe("code block Copy", () => {
  it("copies the raw code, not the highlighted markup, and shows Copied for a moment", async () => {
    vi.useFakeTimers();
    const c = show(reply('Try:\n\n```go\nfunc a() { return "<b>" }\n```'));
    const btn = c.querySelector<HTMLButtonElement>('.cf-code [data-testid="code-copy"]');
    expect(btn?.getAttribute("aria-label")).toBe("Copy code");
    await act(async () => {
      fireEvent.click(btn as HTMLButtonElement);
      await Promise.resolve();
    });
    expect(copyText).toHaveBeenCalledWith('func a() { return "<b>" }');
    expect(btn?.getAttribute("aria-label")).toBe("Copied");
    expect(btn?.textContent).toBe("Copied");
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(btn?.getAttribute("aria-label")).toBe("Copy code");
  });

  it("every fenced block has one, outside replies too (a summary, a report)", () => {
    const c = render(
      <div className="cf-thread">
        <ThreadMarkdown>{"```python\nprint(1)\n```\n\n```bash\nls\n```"}</ThreadMarkdown>
      </div>,
    ).container;
    expect(c.querySelectorAll('[data-testid="code-copy"]')).toHaveLength(2);
    // No reply around them: copy only.
    expect(c.querySelector('[data-testid="code-run"]')).toBeNull();
  });

  it("a Bash row copies its command and offers no Run", async () => {
    const c = show([
      { ...base, id: "u", ordinal: 1, kind: "user", text: "go", attachments: [], composerText: "" },
      {
        ...base,
        id: "tu",
        ordinal: 2,
        kind: "tool",
        toolUseId: "tu",
        name: "Bash",
        inputJson: JSON.stringify({ command: "go test ./... | tail -3" }),
        status: "done",
        output: "ok",
        isError: false,
        resultJson: "",
      },
    ]);
    fireEvent.click(c.querySelector('[data-testid="thread-tool"] button, button[aria-expanded]') as HTMLElement);
    const btn = c.querySelector<HTMLButtonElement>('[data-testid="thread-bash"] [data-testid="code-copy"]');
    expect(btn?.getAttribute("aria-label")).toBe("Copy command");
    await act(async () => {
      fireEvent.click(btn as HTMLButtonElement);
      await Promise.resolve();
    });
    expect(copyText).toHaveBeenCalledWith("go test ./... | tail -3");
    expect(c.querySelector('[data-testid="code-run"]')).toBeNull();
  });
});

describe("code block Run in terminal", () => {
  const runs = (c: HTMLElement) => c.querySelectorAll('[data-testid="code-run"]').length;

  it("a shell block in Claude's reply runs its command in a new shell of the thread", () => {
    const c = show(reply("Run this:\n\n```bash\nmake test\n```"));
    const btn = c.querySelector<HTMLButtonElement>('[data-testid="code-run"]');
    expect(btn?.getAttribute("aria-label")).toBe("Run in terminal");
    fireEvent.click(btn as HTMLButtonElement);
    expect(runInThreadTerminal).toHaveBeenCalledWith("s", "make test");
  });

  it("a console block runs its $ lines only", () => {
    const c = show(reply("```console\n$ go version\ngo version go1.26\n```"));
    fireEvent.click(c.querySelector('[data-testid="code-run"]') as HTMLElement);
    expect(runInThreadTerminal).toHaveBeenCalledWith("s", "go version");
  });

  const none: [string, string, boolean?][] = [
    ["not a shell language", "```python\nprint(1)\n```"],
    ["no language", "```\nls\n```"],
    ["a console block without prompts", "```console\njust output\n```"],
    ["the block still streaming", "Run:\n\n```bash\nmake te", true],
  ];
  it.each(none)("none for %s", (_name, text, streaming) => {
    expect(runs(show(reply(text, streaming)))).toBe(0);
  });

  it("an earlier, finished block of a streaming reply offers it", () => {
    expect(runs(show(reply("```bash\nls\n```\n\nNow the next step", true)))).toBe(1);
  });

  it("none when terminal.new is not available for the thread", () => {
    useCommandsStore.setState({ commands: [terminalNew(false)] });
    expect(runs(show(reply("```bash\nls\n```")))).toBe(0);
  });
});
