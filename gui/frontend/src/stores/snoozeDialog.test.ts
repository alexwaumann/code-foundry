import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "@/api/session";

const snoozeSession = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("./sessionActions", async (orig) => ({ ...(await orig<typeof import("./sessionActions")>()), snoozeSession }));

const { presentSnooze, useSnoozeDialogStore } = await import("./snoozeDialog");
const { presentInPalette } = await import("@/keys/bindings");
const { useSessionsStore } = await import("./sessions");
const { useUiStore } = await import("./ui");

const thread = (id: string, snoozedUntilMs: number | null) => ({ id, name: id, repoId: "", worktreePath: "", workspaceId: "", linkedPullRequests: [], snoozedUntilMs }) as unknown as SessionView;

beforeEach(() => {
  useSessionsStore.setState({ byId: { a: thread("a", null), b: thread("b", 5_000) }, order: ["a", "b"] });
  useSnoozeDialogStore.setState({ open: false, sessionId: "", seq: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("presentSnooze (session.snooze's presenter)", () => {
  it("opens the custom dialog for a thread that is not snoozed", async () => {
    expect(presentSnooze("a")).toBe(true);
    await Promise.resolve();
    expect(useSnoozeDialogStore.getState()).toMatchObject({ open: true, sessionId: "a", seq: 1 });
    expect(snoozeSession).not.toHaveBeenCalled();
  });

  it("unsnoozes a snoozed thread", async () => {
    expect(presentSnooze("b")).toBe(true);
    await Promise.resolve();
    expect(snoozeSession).toHaveBeenCalledWith("b", null);
    expect(useSnoozeDialogStore.getState().open).toBe(false);
  });

  it("falls back without a thread", () => {
    expect(presentSnooze("")).toBe(false);
    expect(presentSnooze("nope")).toBe(false);
  });

  it("replaces the palette's prompts for the selected thread", async () => {
    useUiStore.setState({ selection: { kind: "session", id: "a" } });
    expect(presentInPalette("thread.snooze")).toBe(true);
    await Promise.resolve();
    expect(useSnoozeDialogStore.getState()).toMatchObject({ open: true, sessionId: "a" });
  });
});
