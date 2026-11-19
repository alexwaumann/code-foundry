import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import type { AgentHitView } from "@/api/search";
import type { SentPromptView } from "@/api/thread";
import { openThread as openWorkspaceThread } from "@/components/projects/workspaceHooks";
import { openAgentHit } from "./agentSearch";
import { goToNeedsThread } from "./needs";
import { goToNotificationThread } from "./notificationActions";
import { openThread, previewOnOpen } from "./openThread";
import { revealPrompt } from "./promptHistory";
import { openSearchHit, openSearchThread, openSearchThreadFind } from "./threadSearch";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";

vi.mock("./commands", async (orig) => ({ ...(await orig<typeof import("./commands")>()), runCommandForResult: vi.fn(() => Promise.resolve(null)) }));
vi.mock("./threadFind", async (orig) => ({ ...(await orig<typeof import("./threadFind")>()), openThreadFind: vi.fn() }));

/**
 * Which of the user's clicks open a thread as its space's preview tab (docs/notes/shell-model.md,
 * "Preview tabs"; docs/notes/child-preview-tabs.md): an archived or snoozed thread, or a child
 * whose creator exists, unless the click is in a thread that child created (its lead).
 */

const t = (id: string, o: Partial<ThreadView> = {}) => ({ id, name: id, createdBy: "", archivedAtMs: null, snoozedUntilMs: null, savedAtMs: null, ...o }) as ThreadView;

const THREADS = [
  t("lead"),
  t("child", { createdBy: "lead" }),
  t("grand", { createdBy: "child" }),
  t("orphan", { createdBy: "removed" }),
  t("archived", { archivedAtMs: 1 }),
  t("snoozed", { snoozedUntilMs: 1 }),
  t("saved", { savedAtMs: 1 }),
  t("archivedLead", { archivedAtMs: 1 }),
  t("underArchived", { createdBy: "archivedLead" }),
];
const byId = Object.fromEntries(THREADS.map((x) => [x.id, x]));

describe("previewOnOpen", () => {
  it.each([
    ["an active thread of the sidebar", "lead", "", false],
    ["a child whose creator exists", "child", "", true],
    ["a grandchild", "grand", "", true],
    ["a child of an archived creator (it still exists)", "underArchived", "", true],
    ["a child whose creator was removed (it is in the sidebar)", "orphan", "", false],
    ["an archived thread", "archived", "", true],
    ["a snoozed thread", "snoozed", "", true],
    ["a thread saved for later", "saved", "", true],
    ["a thread not listed yet", "unknown", "", false],
    ["a child from its own child (its lead, opened from below)", "child", "grand", false],
    ["a child from its creator", "child", "lead", true],
    ["a grandchild from its parent", "grand", "child", true],
    ["a child from an unrelated thread", "child", "archived", true],
  ])("%s", (_name, id, from, want) => {
    expect(previewOnOpen(byId, id, from)).toBe(want);
  });
});

describe("openThread and the call sites that route through it", () => {
  let select: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    useThreadsStore.setState({ byId, order: THREADS.map((x) => x.id) });
    select = vi.fn();
    useUiStore.setState({ select } as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks for a preview from the thread, with the prompt focused unless told otherwise", () => {
    openThread("child");
    openThread("lead");
    openThread("child", { from: "grand" });
    openThread("child", { focusPrompt: false });
    openThread("archived", { preview: false });
    expect(select.mock.calls).toEqual([
      [{ kind: "thread", id: "child" }, { focusPrompt: true, preview: true }],
      [{ kind: "thread", id: "lead" }, { focusPrompt: true }],
      [{ kind: "thread", id: "child" }, { focusPrompt: true, from: "grand" }],
      [{ kind: "thread", id: "child" }, { focusPrompt: false, preview: true }],
      [{ kind: "thread", id: "archived" }, { focusPrompt: true }],
    ]);
  });

  const hit: AgentHitView = { n: 1, threadId: "child", threadName: "child", archived: false, itemId: "i-1", ordinal: 1 } as AgentHitView;
  const prompt: SentPromptView = { threadId: "child", threadName: "child", itemId: "i-1", text: "go", sentAt: new Date(0), composerText: "" };
  it.each([
    ["a thread search hit", () => { openSearchHit({ threadId: "child", itemId: "i-1" }, "q"); }, false],
    ["a thread search name", () => { openSearchThread("child"); }, true],
    ["a thread search header", () => { openSearchThreadFind("child", "q"); }, false],
    ["an agent search hit", () => { openAgentHit("e-1", hit); }, false],
    ["a notification's thread link", () => { goToNotificationThread("child"); }, true],
    ["Needs you's Go to thread", () => { goToNeedsThread("child"); }, true],
    ["a prompt in prompt history", () => { revealPrompt(prompt); }, false],
    ["a Projects page thread row", () => { openWorkspaceThread("child"); }, false],
  ])("%s opens a child as a preview", (_name, run, focusPrompt) => {
    run();
    expect(select).toHaveBeenCalledWith({ kind: "thread", id: "child" }, { focusPrompt, preview: true });
  });
});
