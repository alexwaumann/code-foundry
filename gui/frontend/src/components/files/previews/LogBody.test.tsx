import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { blankFile, type FileReadView } from "@/api/files";
import { useCodeViewStore } from "@/stores/codeView";
import { AnsiBody, LogBody } from "./LogBody";
import type { PreviewBodyProps } from "./types";

// jsdom lays nothing out (testing-gotchas.md): every row at its estimated size.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (o: { count: number; estimateSize: (i: number) => number; getItemKey: (i: number) => number; paddingStart?: number }) => {
    const items: { index: number; key: number; start: number; size: number; end: number }[] = [];
    let at = o.paddingStart ?? 0;
    for (let i = 0; i < o.count; i++) {
      const size = o.estimateSize(i);
      items.push({ index: i, key: o.getItemKey(i), start: at, size, end: at + size });
      at += size;
    }
    return { getVirtualItems: () => items, getTotalSize: () => at, getVirtualItemForOffset: () => items[0], measureElement: () => undefined, scrollToIndex: () => undefined };
  },
}));

const E = "\u001b";
const DAEMON = [
  'time=2026-11-14T09:14:02.113-08:00 level=INFO msg="daemon listening" port=7421 version=v0.22.0-tip.3',
  'time=2026-11-14T09:14:02.131-08:00 level=DEBUG msg="fsevents stream started" paths=6',
  'time=2026-11-14T09:14:09.902-08:00 level=WARN msg="gh rate limit low" remaining=112 reset=41m',
  'time=2026-11-14T09:15:47.224-08:00 level=ERROR msg="worktree add failed" project=code-foundry',
  "fatal: a branch named 'cf/file-formats' already exists",
  "goroutine 84 [running]:",
  'time=2026-11-14T09:15:47.229-08:00 level=INFO msg="thread stopped" reason=crashed',
].join("\n");

function props(path: string, text: string, over: Partial<FileReadView> = {}): PreviewBodyProps {
  return { file: { ...blankFile(path), text, size: text.length, ...over }, path, mode: "rendered", name: path, place: { project: "", dir: "/w", file: path }, page: undefined, reloads: 0, findKey: undefined, onMeta: vi.fn(), onMode: vi.fn() };
}

afterEach(() => {
  cleanup();
});

const rows = () => screen.getAllByTestId("file-log-row");
const texts = () => rows().map((r) => r.textContent);

describe("LogBody", () => {
  it("lays a structured log out as time, level, message and dimmed fields, tinting warn and error rows and their trace", () => {
    render(<LogBody {...props("/w/daemon.log", DAEMON)} />);
    expect(texts()).toEqual([
      "09:14:02.113INFOdaemon listening port=7421 version=v0.22.0-tip.3",
      "09:14:02.131DEBUGfsevents stream started paths=6",
      "09:14:09.902WARNgh rate limit low remaining=112 reset=41m",
      "09:15:47.224ERRORworktree add failed project=code-foundry",
      "fatal: a branch named 'cf/file-formats' already exists",
      "goroutine 84 [running]:",
      "09:15:47.229INFOthread stopped reason=crashed",
    ]);
    expect(rows().map((r) => r.dataset.level ?? "")).toEqual(["INFO", "DEBUG", "WARN", "ERROR", "ERROR", "ERROR", "INFO"]);
    expect(rows()[2]?.className).toContain("bg-cf-warning-surface");
    expect(rows()[4]?.className).toContain("bg-cf-error-surface");
    expect(rows()[0]?.className).not.toContain("surface");
    const key = within(rows()[0] as HTMLElement).getByText("port=");
    expect(key.className).toContain("text-cf-text-muted");
    expect(within(rows()[0] as HTMLElement).getByText("7421").className).toContain("text-cf-text-secondary");
    // The full timestamp is hidden information, behind the short one.
    expect(within(rows()[0] as HTMLElement).getByTestId("file-log-time").textContent).toBe("09:14:02.113");
  });

  it("the level filter: counts per level, and Error keeps its trace", () => {
    render(<LogBody {...props("/w/daemon.log", DAEMON)} />);
    const filter = screen.getByTestId("file-log-filter");
    expect(within(filter).getAllByRole("radio").map((r) => r.textContent)).toEqual(["All7", "Info2", "Warn1", "Error3", "Debug1"]);
    fireEvent.click(screen.getByTestId("file-log-filter-error"));
    expect(texts()).toEqual(["09:15:47.224ERRORworktree add failed project=code-foundry", "fatal: a branch named 'cf/file-formats' already exists", "goroutine 84 [running]:"]);
    fireEvent.click(screen.getByTestId("file-log-filter-all"));
    expect(rows()).toHaveLength(7);
  });

  it("no filter and no columns for a log that says no levels or times", () => {
    render(<LogBody {...props("/w/plain.log", "just text\nmore text\n")} />);
    expect(screen.queryByTestId("file-log-filter")).toBeNull();
    expect(texts()).toEqual(["just text", "more text"]);
  });

  it("an empty log has no rows and no filter", () => {
    render(<LogBody {...props("/w/empty.log", "")} />);
    expect(screen.queryAllByTestId("file-log-row")).toEqual([]);
    expect(screen.queryByTestId("file-log-filter")).toBeNull();
    expect(screen.getByTestId("file-log-rows").dataset.count).toBe("0");
  });

  it("a JSON log line: time, level, message, then the other keys", () => {
    render(<LogBody {...props("/w/app.log", '{"time":"2026-11-14T09:14:02.113Z","level":"warn","msg":"slow","id":"t-1","ms":812}\n')} />);
    expect(texts()).toEqual(["09:14:02.113WARNslow id=t-1 ms=812"]);
  });

  it("ANSI colours: the 16 as the terminal palette, carried across lines; other escapes gone", () => {
    render(<AnsiBody {...props("/w/run.txt", `${E}]0;title\u0007${E}[1;41m FAIL ${E}[0m a.test.ts\n${E}[32m✓ one\nstill green${E}[0m\n`)} />);
    expect(texts()).toEqual([" FAIL  a.test.ts", "✓ one", "still green"]);
    const fail = within(rows()[0] as HTMLElement).getByText("FAIL", { exact: false });
    expect(fail.style.backgroundColor).toBe("var(--terminal-ansi-1)");
    expect(fail.style.fontWeight).toBe("700");
    expect(within(rows()[2] as HTMLElement).getByText("still green").style.color).toBe("var(--terminal-ansi-2)");
  });

  it("terminal output is never read for levels", () => {
    render(<AnsiBody {...props("/w/run.txt", `${E}[0m2026-11-14 09:14:02 ERROR not a log entry\n`)} />);
    expect(screen.queryByTestId("file-log-filter")).toBeNull();
    expect(texts()).toEqual(["2026-11-14 09:14:02 ERROR not a log entry"]);
    expect(rows()[0]?.dataset.level).toBeUndefined();
  });

  it("wraps with the wrap toggle; unwrapped, the rows are as wide as the longest line", () => {
    useCodeViewStore.setState({ wrap: false });
    const { rerender } = render(<AnsiBody {...props("/w/run.txt", `${E}[1m${"x".repeat(300)}\n`)} />);
    const sizer = screen.getByTestId("file-log-rows").firstElementChild as HTMLElement;
    expect(sizer.style.width).toMatch(/^max\(100%, (calc\()?300ch \+ 24px\)?\)$/);
    expect(within(rows()[0] as HTMLElement).getByText("x".repeat(300)).parentElement?.className).toContain("whitespace-pre");
    useCodeViewStore.setState({ wrap: true });
    rerender(<AnsiBody {...props("/w/run.txt", `${E}[1m${"x".repeat(300)}\n`)} />);
    expect(sizer.style.width).toBe("100%");
    expect(within(rows()[0] as HTMLElement).getByText("x".repeat(300)).parentElement?.className).toContain("whitespace-pre-wrap");
  });
});
