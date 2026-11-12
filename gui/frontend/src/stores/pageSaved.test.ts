import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { useThreadsStore } from "./threads";

const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const runCommand = vi.hoisted(() => vi.fn());
vi.mock("./commands", () => ({ runCommand }));
const openFileInPanel = vi.hoisted(() => vi.fn());
vi.mock("./filePanel", () => ({ openFileInPanel }));
const { noticePageResult, savedPath } = await import("./pageSaved");

const exported = (path: string) => ({ message: `saved ${path} (12 bytes)`, resultJson: JSON.stringify({ path, size: 12 }) });
const thread = (over: Partial<ThreadView>): ThreadView => ({ id: "t-1", name: "Fix", projectId: "p-1", worktreePath: "/Users/me/wt/fix", workspaceId: "", ...over }) as ThreadView;

interface Shown {
  description: string;
  action: { label: string; onClick: () => void };
  cancel: { label: string; onClick: () => void };
}
const shown = (): [string, Shown] => toast.success.mock.calls[0] as [string, Shown];

beforeEach(() => {
  toast.success.mockReset();
  runCommand.mockReset();
  openFileInPanel.mockReset();
  useThreadsStore.setState({ byId: { "t-1": thread({}) }, order: ["t-1"] });
});

describe("savedPath", () => {
  it.each([
    ["file.export with an absolute path", "file.export", exported("/Users/me/wt/fix/rows.csv"), "/Users/me/wt/fix/rows.csv"],
    ["another verb", "thread.list", exported("/Users/me/wt/fix/rows.csv"), ""],
    ["no result", "file.export", null, ""],
    ["a result that is not JSON", "file.export", { message: "", resultJson: "saved" }, ""],
    ["a relative path", "file.export", exported("rows.csv"), ""],
    ["no path", "file.export", { message: "", resultJson: "{}" }, ""],
  ])("%s", (_name, verb, res, want) => {
    expect(savedPath(verb, res)).toBe(want);
  });
});

describe("noticePageResult", () => {
  it("names the saved file, opens it in the thread's side panel, and shows it in Finder", () => {
    noticePageResult("t-1", "file.export", exported("/Users/me/wt/fix/out/rows.csv"));
    expect(toast.success).toHaveBeenCalledTimes(1);
    const [title, opts] = shown();
    expect(title).toBe("Saved rows.csv");
    expect(opts.description).toBe("~/wt/fix/out/rows.csv");
    expect(opts.action.label).toBe("Open");
    opts.action.onClick();
    expect(openFileInPanel).toHaveBeenCalledWith("thread:t-1", { project: "p-1", base: "/Users/me/wt/fix", path: "/Users/me/wt/fix/out/rows.csv" });
    expect(opts.cancel.label).toBe("Show in Finder");
    opts.cancel.onClick();
    expect(runCommand).toHaveBeenCalledWith(
      "worktree.reveal",
      { worktree: "/Users/me/wt/fix", file: "/Users/me/wt/fix/out/rows.csv" },
      expect.objectContaining({ activeProjectId: "p-1", activeWorktreePath: "/Users/me/wt/fix" }),
    );
  });

  it("reveals in the file's folder when the thread is not loaded", () => {
    useThreadsStore.setState({ byId: {}, order: [] });
    noticePageResult("t-1", "file.export", exported("/Users/me/rows.csv"));
    shown()[1].cancel.onClick();
    expect(runCommand).toHaveBeenCalledWith("worktree.reveal", { worktree: "/Users/me", file: "/Users/me/rows.csv" }, expect.anything());
  });

  it("shows nothing for a run that wrote no file", () => {
    noticePageResult("t-1", "thread.list", { message: "", resultJson: "[]" });
    noticePageResult("t-1", "file.export", null);
    expect(toast.success).not.toHaveBeenCalled();
  });
});
