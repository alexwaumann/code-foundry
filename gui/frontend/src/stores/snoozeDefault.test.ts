import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";

const snoozeThread = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const saveThreadForLater = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/threadActions", async (orig) => ({ ...(await orig<typeof import("@/stores/threadActions")>()), snoozeThread, saveThreadForLater }));

const { defaultSnoozeOf, presentSnoozeDefault } = await import("./snoozeDefault");
const { presentCommand } = await import("@/keys/bindings");
const { useSettingsStore } = await import("./settings");
const { useThreadsStore } = await import("./threads");
const { useUiStore } = await import("./ui");
const { snoozePresets } = await import("@/lib/snooze");

function setDefault(v: string | undefined): void {
  useSettingsStore.setState({ snapshot: { values: v === undefined ? {} : { "threads.default_snooze": v }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
}

// Wednesday 2026-11-18, 2:12 PM local.
const NOW = new Date(2026, 10, 18, 14, 12).getTime();

beforeEach(() => {
  vi.clearAllMocks();
  useThreadsStore.setState({ byId: { "s-1": { id: "s-1", projectId: "", worktreePath: "", workspaceId: "" } as ThreadView }, order: ["s-1"] });
  setDefault(undefined);
});

describe("defaultSnoozeOf", () => {
  it.each([
    [undefined, "tomorrow"],
    ["", "tomorrow"],
    ["1h", "1h"],
    ["3h", "3h"],
    ["next-week", "next-week"],
    ["save", "save"],
    ["soon", "tomorrow"],
  ])("%s is %s", (v, want) => {
    expect(defaultSnoozeOf(v)).toBe(want);
  });
});

describe("Snooze to Default (thread.snooze.default's presenter)", () => {
  const at = (id: string) => snoozePresets(NOW).find((p) => p.id === id)?.untilMs;

  it.each([
    { name: "unset: tomorrow at 9:00 AM", value: undefined, until: () => at("tomorrow") },
    { name: "1 hour", value: "1h", until: () => at("1h") },
    { name: "next week: Monday at 9:00 AM", value: "next-week", until: () => at("next-week") },
  ])("snoozes the thread through thread.snooze, toasted: $name", ({ value, until }) => {
    setDefault(value);
    expect(presentSnoozeDefault("s-1", NOW)).toBe(true);
    expect(snoozeThread).toHaveBeenCalledWith("s-1", until(), { inView: false });
    expect(saveThreadForLater).not.toHaveBeenCalled();
  });

  it("saves it for later when that is the default", () => {
    setDefault("save");
    expect(presentSnoozeDefault("s-1", NOW)).toBe(true);
    expect(saveThreadForLater).toHaveBeenCalledWith("s-1", { inView: false });
    expect(snoozeThread).not.toHaveBeenCalled();
  });

  it("without the thread, leaves it to the daemon", () => {
    expect(presentSnoozeDefault("s-9", NOW)).toBe(false);
    expect(snoozeThread).not.toHaveBeenCalled();
  });

  it("is the command's presenter, on the thread in view", () => {
    useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
    expect(presentCommand("thread.snooze.default")).toBe(true);
    expect(snoozeThread).toHaveBeenCalledTimes(1);
    expect((snoozeThread.mock.calls[0] as unknown[])[0]).toBe("s-1");
  });
});
