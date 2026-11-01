import { ConnectError } from "@connectrpc/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commands = vi.hoisted(() => ({ invokeConfirmed: vi.fn(), refreshCommands: vi.fn() }));
vi.mock("./commands", async (importOriginal) => ({ ...(await importOriginal<typeof import("./commands")>()), ...commands }));
vi.mock("./context", () => ({ getUiContext: (target: { id: string }) => ({ activeThreadId: target.id }) }));

const { sendThreadDraft, threadDraftKey } = await import("./threadActions");
const { getDraft, updateDraft } = await import("./compose");

const key = threadDraftKey("s-2");

beforeEach(() => {
  vi.clearAllMocks();
  updateDraft(key, { text: "hello while down", error: null, phase: "idle" });
});

// What the composer shows for each failure is api/stream.test.ts's (sendErrorMessage).
describe("sendThreadDraft", () => {
  it("a send that never reached the daemon (WebKit's failed fetch) keeps the message and says why", async () => {
    commands.invokeConfirmed.mockRejectedValueOnce(ConnectError.from(new TypeError("Load failed")));
    expect(await sendThreadDraft("s-2")).toBe(false);
    expect(getDraft(key)).toMatchObject({
      text: "hello while down",
      phase: "idle",
      error: "Code Foundry's daemon is not reachable; your message is kept. Retry when it is back.",
    });
  });

  it("a send that went clears the draft", async () => {
    commands.invokeConfirmed.mockResolvedValueOnce({ message: "", resultJson: "" });
    expect(await sendThreadDraft("s-2")).toBe(true);
    expect(getDraft(key).text).toBe("");
  });
});
