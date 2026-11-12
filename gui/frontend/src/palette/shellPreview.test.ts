import { describe, expect, it, vi } from "vitest";
import { resetShellFlag, SHELL_FLAG_KEY } from "@/shell/flag";
import { shellPreviewEntry, toggleShellPreview } from "./shellPreview";

describe("Toggle new shell (preview)", () => {
  it("is a palette row of its own name, not a daemon verb", () => {
    expect(shellPreviewEntry).toMatchObject({ name: "gui.shell.preview", title: "Toggle new shell (preview)", available: true, args: [] });
  });

  it("turns the shell off (it is the default) and reloads", () => {
    const store = { setItem: vi.fn(), removeItem: vi.fn() };
    const reload = vi.fn();
    toggleShellPreview(store, reload);
    expect(store.setItem).toHaveBeenCalledWith(SHELL_FLAG_KEY, "0");
    expect(store.removeItem).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("turns it back on by forgetting the stored 0", () => {
    localStorage.setItem(SHELL_FLAG_KEY, "0");
    resetShellFlag();
    const store = { setItem: vi.fn(), removeItem: vi.fn() };
    toggleShellPreview(store, vi.fn());
    expect(store.removeItem).toHaveBeenCalledWith(SHELL_FLAG_KEY);
    expect(store.setItem).not.toHaveBeenCalled();
    localStorage.removeItem(SHELL_FLAG_KEY);
    resetShellFlag();
  });
});
