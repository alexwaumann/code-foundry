import { beforeEach, describe, expect, it, vi } from "vitest";

const commands = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock("./commands", async (importOriginal) => ({ ...(await importOriginal<typeof import("./commands")>()), ...commands }));
vi.mock("./context", () => ({ getUiContext: (target: { id: string }) => ({ activeSessionId: target.id }) }));

const { snoozeSession, SESSION_COMMANDS } = await import("./sessionActions");

beforeEach(() => {
  vi.clearAllMocks();
  commands.runCommand.mockResolvedValue(true);
});

describe("snoozeSession", () => {
  it("sends an absolute time as RFC 3339 in the thread's context", async () => {
    expect(await snoozeSession("s1", Date.UTC(2026, 9, 15, 14, 0))).toBe(true);
    expect(commands.runCommand).toHaveBeenCalledWith(SESSION_COMMANDS.snooze, { until: "2026-10-15T14:00:00.000Z" }, { activeSessionId: "s1" });
    expect(SESSION_COMMANDS.snooze).toBe("session.snooze");
  });

  it("null unsnoozes with clear", async () => {
    await snoozeSession("s2", null);
    expect(commands.runCommand).toHaveBeenCalledWith("session.snooze", { clear: "true" }, { activeSessionId: "s2" });
  });
});
