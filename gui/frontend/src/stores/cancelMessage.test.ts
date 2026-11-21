import { Code, ConnectError } from "@connectrpc/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Cancel and Re-send of a message Claude has not read (docs/notes/cancel-queued-messages.md):
// which command runs with which args, the text back in the composer (the failed-prompt
// notice's Edit path), and the quiet "already read" refusal.

const commands = vi.hoisted(() => ({ runCommand: vi.fn(), runCommandForResult: vi.fn(), refreshCommands: vi.fn() }));
vi.mock("./commands", async (importOriginal) => ({ ...(await importOriginal<typeof import("./commands")>()), ...commands }));
vi.mock("./context", () => ({ getUiContext: (target: { id: string }) => ({ activeThreadId: target.id }) }));
const notify = vi.hoisted(() => vi.fn<(n: { level: string; title: string; description?: unknown }) => void>());
vi.mock("@/lib/notify", () => ({ notify, notifyProgress: vi.fn(), dismissNotice: vi.fn() }));
const focus = vi.hoisted(() => vi.fn());
vi.mock("./cite", async (importOriginal) => ({ ...(await importOriginal<typeof import("./cite")>()), focusCiteTarget: focus }));

const { cancelThreadMessage, goneAttachmentsOf, resendNotSentMessage, THREAD_COMMANDS } = await import("./threadActions");
const { getDraft, updateDraft, clearDraft } = await import("./compose");
const { threadDraftKey } = await import("@/lib/threadDraft");
const { tagToken } = await import("@/lib/prompt");

const key = threadDraftKey("s1");
const sent = { text: "Also add a README table", composerText: "", attachments: [] as string[] };

/** runCommandForResult failing with err: calls `expected` like the real one (a toast unless expected), then resolves null. */
function failWith(err: unknown) {
  commands.runCommandForResult.mockImplementationOnce((_name: string, _args: unknown, opts: { expected?: (err: unknown) => boolean }) => {
    if (!opts.expected?.(err)) notify({ level: "error", title: "Cancel Message failed" });
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearDraft(key);
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    fn();
    return 0;
  });
});

describe("cancelThreadMessage", () => {
  it("runs thread.message.cancel for the message, quiet, and puts its text in the composer, focused", async () => {
    commands.runCommandForResult.mockResolvedValueOnce({ message: "cancelled", resultJson: "{}" });
    expect(await cancelThreadMessage("s1", "m1", sent)).toBe(true);
    expect(THREAD_COMMANDS.cancelMessage).toBe("thread.message.cancel");
    expect(commands.runCommandForResult).toHaveBeenCalledWith("thread.message.cancel", { id: "s1", message: "m1" }, expect.objectContaining({ ctx: { activeThreadId: "s1" }, quiet: true }));
    expect(getDraft(key).text).toBe("Also add a README table");
    expect(focus).toHaveBeenCalledWith(key);
  });

  it("keeps a draft: the cancelled text goes after it, a blank line between (the Edit path's rule)", async () => {
    updateDraft(key, { text: "draft I was typing" });
    commands.runCommandForResult.mockResolvedValueOnce({ message: "cancelled", resultJson: "{}" });
    await cancelThreadMessage("s1", "m1", sent);
    expect(getDraft(key).text).toBe("draft I was typing\n\nAlso add a README table");
  });

  it("brings the tags back as the composer had them", async () => {
    commands.runCommandForResult.mockResolvedValueOnce({ message: "cancelled", resultJson: "{}" });
    const composerText = `Fix ${tagToken({ tagKind: "file", projectId: "p1", path: "src/a.ts" })} please`;
    await cancelThreadMessage("s1", "m1", { text: "Fix src/a.ts please", composerText, attachments: [] });
    expect(getDraft(key).text).toBe(composerText);
  });

  it("Claude read it first: a quiet notice, no error toast, the composer untouched", async () => {
    updateDraft(key, { text: "draft" });
    failWith(new ConnectError("failed precondition: message m1: already read by Claude before it could be cancelled", Code.FailedPrecondition));
    expect(await cancelThreadMessage("s1", "m1", sent)).toBe(false);
    expect(notify.mock.calls.map(([n]) => [n.level, n.title])).toEqual([["info", "Claude already read your message"]]);
    expect(getDraft(key).text).toBe("draft");
    expect(focus).not.toHaveBeenCalled();
  });

  it("another failure toasts as an error and changes nothing", async () => {
    failWith(new ConnectError("thread s1 is archived", Code.FailedPrecondition));
    expect(await cancelThreadMessage("s1", "m1", sent)).toBe(false);
    expect(notify.mock.calls.map(([n]) => n.level)).toEqual(["error"]);
    expect(getDraft(key).text).toBe("");
  });

  it("a second press while the first is on its way sends nothing", async () => {
    let done: (v: unknown) => void = () => {};
    commands.runCommandForResult.mockReturnValueOnce(new Promise((r) => (done = r)));
    const first = cancelThreadMessage("s1", "m1", sent);
    expect(await cancelThreadMessage("s1", "m1", sent)).toBe(false);
    done({ message: "", resultJson: "{}" });
    await first;
    expect(commands.runCommandForResult).toHaveBeenCalledTimes(1);
  });
});

describe("resendNotSentMessage", () => {
  it("runs thread.message.resend for the message, quiet; the draft stays as it is", async () => {
    updateDraft(key, { text: "draft" });
    commands.runCommandForResult.mockResolvedValueOnce({ message: "sent again", resultJson: "{}" });
    expect(await resendNotSentMessage("s1", "m2")).toBe(true);
    expect(commands.runCommandForResult).toHaveBeenCalledWith("thread.message.resend", { id: "s1", message: "m2" }, expect.objectContaining({ quiet: true }));
    expect(getDraft(key).text).toBe("draft");
    expect(notify).not.toHaveBeenCalled();
  });

  it("says which attachments were no longer staged", async () => {
    commands.runCommandForResult.mockResolvedValueOnce({ message: "sent again", resultJson: JSON.stringify({ item: {}, goneAttachments: ["shot.png"] }) });
    await resendNotSentMessage("s1", "m2");
    expect(notify.mock.calls.map(([n]) => [n.level, n.title])).toEqual([["info", "Sent without shot.png"]]);
  });

  it("reads gone attachments defensively", () => {
    expect(goneAttachmentsOf("")).toEqual([]);
    expect(goneAttachmentsOf("not json")).toEqual([]);
    expect(goneAttachmentsOf('{"goneAttachments":["a.png",3]}')).toEqual(["a.png"]);
  });
});
