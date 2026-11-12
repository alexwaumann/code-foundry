import { describe, expect, it, vi } from "vitest";
import { SHELL_FLAG_KEY } from "@/shell/flag";
import { shellPreviewEntry, toggleShellPreview } from "./shellPreview";

describe("Toggle new shell (preview)", () => {
  it("is a palette row of its own name, not a daemon verb", () => {
    expect(shellPreviewEntry).toMatchObject({ name: "gui.shell.preview", title: "Toggle new shell (preview)", available: true, args: [] });
  });

  it("turns the flag on (the shell is off in tests) and reloads", () => {
    const store = { setItem: vi.fn(), removeItem: vi.fn() };
    const reload = vi.fn();
    toggleShellPreview(store, reload);
    expect(store.setItem).toHaveBeenCalledWith(SHELL_FLAG_KEY, "1");
    expect(store.removeItem).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });
});
