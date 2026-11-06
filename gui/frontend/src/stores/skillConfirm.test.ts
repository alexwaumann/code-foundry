import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvokeResultView } from "@/api/command";
import { skillItemKey } from "@/api/skill";
import { RESTART_WARNING, setSkillMarketplaceDeps, useSkillMarketplaceStore } from "./skill";
import { setSkillEnabled } from "./skillConfirm";

const toast = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: Object.assign(toast, { error: vi.fn(), success: vi.fn() }) }));

const item = { kind: "skill" as const, name: "pr-review", registry: "ai-marketplace" };
const key = skillItemKey(item.kind, item.name, item.registry);
const ok: InvokeResultView = { message: "done", resultJson: "" };

function seed(enabled: boolean) {
  useSkillMarketplaceStore.setState({ installed: { installed: [{ key, enabled } as never], pluginsError: "", epoch: 1 } });
}
const enabled = () => useSkillMarketplaceStore.getState().installed?.installed[0]?.enabled;

beforeEach(() => {
  toast.mockReset();
  setSkillMarketplaceDeps(null);
});

describe("setSkillEnabled", () => {
  it("disabling runs quietly and says the restart warning in one toast", async () => {
    const run = vi.fn(() => Promise.resolve(ok));
    setSkillMarketplaceDeps({ run });
    seed(true);
    expect(await setSkillEnabled(item, false)).toBe(true);
    expect(run).toHaveBeenCalledWith("skill.disable", { name: "pr-review", kind: "skill" }, expect.objectContaining({ quiet: true }));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("Disabled pr-review", expect.objectContaining({ description: RESTART_WARNING }));
  });

  it("the row reads as flipped when the command returns, before the re-read", async () => {
    setSkillMarketplaceDeps({ run: () => Promise.resolve(ok) });
    seed(true);
    await setSkillEnabled(item, false);
    expect(enabled()).toBe(false);
    await setSkillEnabled(item, true);
    expect(enabled()).toBe(true);
  });

  it("is busy with the action while it runs, so the switch can show what it asked for", async () => {
    let finish: (r: InvokeResultView) => void = () => undefined;
    setSkillMarketplaceDeps({ run: () => new Promise((r) => (finish = r)) });
    seed(true);
    const done = setSkillEnabled(item, false);
    expect(useSkillMarketplaceStore.getState().busy[key]).toBe("disable");
    finish(ok);
    await done;
    expect(useSkillMarketplaceStore.getState().busy[key]).toBeUndefined();
  });

  it("a failure leaves the row as it was, with no warning, and the failure under it", async () => {
    setSkillMarketplaceDeps({
      run: (_n, _a, o) => {
        o.onError?.("it is in use");
        return Promise.resolve(null);
      },
    });
    seed(true);
    expect(await setSkillEnabled(item, false)).toBe(false);
    expect(enabled()).toBe(true);
    expect(toast).not.toHaveBeenCalled();
    expect(useSkillMarketplaceStore.getState().failures[key]).toEqual({ action: "disable", message: "it is in use" });
  });

  it("enabling says nothing of restarts", async () => {
    setSkillMarketplaceDeps({ run: () => Promise.resolve(ok) });
    seed(false);
    expect(await setSkillEnabled(item, true)).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });
});
