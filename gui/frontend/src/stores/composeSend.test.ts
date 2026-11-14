import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { daemon, invocationsOf, lastInvocation, resetDaemon } from "@/test/daemonFakes";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
// Staging an attachment waits for the test.
const staging = vi.hoisted(() => ({ resolve: (() => undefined) as (path: string) => void, calls: 0 }));
vi.mock("@/api/threads", async (orig) => ({
  ...(await orig<typeof import("@/api/threads")>()),
  stageAttachment: () =>
    new Promise<string>((r) => {
      staging.calls++;
      staging.resolve = r;
    }),
}));

const { getDraft, sendDraft, updateDraft, useComposeStore } = await import("./compose");
const { resetLayout } = await import("./layout");
const { setShellMode } = await import("./shellView");
const { useThreadsStore } = await import("./threads");

/**
 * Sending from a compose tab in the window shell (docs/notes/shell-review-fixes-gui.md): the tab the
 * send names is the composer that sent, never what has the focus when an await returns; a like
 * draft's send names it too; a draft whose tab went is ended once its thread exists.
 */

const DEFAULTS = { model: "m", effort: "e" };
const draftTab = (id: string, draft: string) => tab(id, "compose", "", { key: `compose:draft:${draft}`, params: { draft } });
/** Two drafts side by side, `focus` the focused one's pane. */
const twoDrafts = (focus: "p-a" | "p-b", rev = 1) =>
  layoutOf(
    [
      space(row("s-1", [pane("p-a", [draftTab("t-a", "d-a")]), pane("p-b", [draftTab("t-b", "d-b")])]), focus, {
        drafts: [
          { id: "d-a", label: "A", params: {} },
          { id: "d-b", label: "B", params: {} },
        ],
      }),
    ],
    rev,
  );

const image = () => ({ id: "att-1", file: new File(["x"], "a.png", { type: "image/png" }), kind: "image" as const, url: "", stagedPath: null, pages: null, thumb: null });

beforeEach(async () => {
  resetDaemon();
  staging.calls = 0;
  resetLayout();
  setShellMode("shell");
  useComposeStore.setState({ drafts: {} });
  daemon.handlers.set("thread.new", () => ({ message: "", resultJson: JSON.stringify({ id: "s-new" }) }));
  daemon.handlers.set("thread.new-like", () => ({ message: "", resultJson: JSON.stringify({ id: "s-new" }) }));
  await seedLayout(twoDrafts("p-a"));
});

afterEach(() => {
  vi.useRealTimers();
  resetLayout();
});

describe("a draft's send", () => {
  it("names its own tab though another draft took the focus while its attachment was staged", async () => {
    updateDraft("draft:d-a", { text: "First", attachments: [image()] });
    updateDraft("draft:d-b", { text: "Second" });
    const sent = sendDraft({ kind: "home", draft: "d-a" }, DEFAULTS, [], { composeTab: "t-a" });
    await vi.waitFor(() => {
      expect(staging.calls).toBe(1);
    });
    // The user moved to the other draft while the file uploaded.
    await seedLayout(twoDrafts("p-b", 2));
    staging.resolve("/staged/a.png");
    await expect(sent).resolves.toBe(true);
    expect(lastInvocation("thread.new")?.args.compose).toBe("t-a");
    expect(getDraft("draft:d-b").text).toBe("Second");
  });

  it("New thread on this branch names its tab too, so the draft ends with it", async () => {
    useThreadsStore.setState({ order: ["s-1"], byId: { "s-1": { id: "s-1", projectId: "", projectIds: [], workspaceId: "", worktreePath: "/home", name: "Src" } as unknown as ThreadView } });
    updateDraft("draft:d-a", { text: "Next step" });
    await expect(sendDraft({ kind: "like", threadId: "s-1", draft: "d-a" }, DEFAULTS, [], { composeTab: "t-a" })).resolves.toBe(true);
    expect(lastInvocation("thread.new-like")?.args).toMatchObject({ id: "s-1", compose: "t-a" });
  });

  it("a draft whose tab closed during the send is not named, and is discarded once its thread exists", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    updateDraft("draft:d-a", { text: "First", attachments: [image()] });
    const sent = sendDraft({ kind: "home", draft: "d-a" }, DEFAULTS, [], { composeTab: "t-a" });
    await vi.waitFor(() => {
      expect(staging.calls).toBe(1);
    });
    // Its tab closed; the draft stays listed (closing a draft's tab keeps the draft).
    const was = twoDrafts("p-b", 2);
    await seedLayout({ ...was, spaces: was.spaces.map((sp) => ({ ...sp, root: pane("p-b", [draftTab("t-b", "d-b")]), focus: "p-b" })) });
    staging.resolve("/staged/a.png");
    await expect(sent).resolves.toBe(true);
    expect(lastInvocation("thread.new")?.args.compose).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2100);
    await vi.waitFor(() => {
      expect(invocationsOf("composer.draft.discard").map((i) => i.args)).toEqual([{ draft: "d-a" }]);
    });
  });
});
