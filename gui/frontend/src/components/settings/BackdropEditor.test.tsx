// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackdropView, SettingFieldView } from "@/api/settings";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

// The host: hosted or not, and what the open panel returns.
const host = vi.hoisted(() => ({
  hosted: true,
  pickFiles: vi.fn<(startDir: string) => Promise<string[] | null>>(),
}));
vi.mock("@/api/app", async (orig) => ({
  ...(await orig<typeof import("@/api/app")>()),
  appInfo: () => Promise.resolve(host.hosted ? { version: "test" } : null),
  pickFiles: host.pickFiles,
}));
vi.mock("@/api/filesystem", async (orig) => ({
  ...(await orig<typeof import("@/api/filesystem")>()),
  listDirectories: () => Promise.resolve({ entries: [{ path: "/Users/me/Pictures", name: "Pictures", isGit: false, registered: false }], completion: "~/Pictures/", truncated: false }),
}));

// The daemon's folder: a list the import and remove mocks change.
const daemon = vi.hoisted(() => ({
  images: [] as BackdropView[],
  importBackdrop: vi.fn<(path: string) => Promise<BackdropView | null>>(),
  removeBackdrop: vi.fn<(name: string) => Promise<void>>(),
  readBackdrop: vi.fn(() => Promise.resolve({ data: new Uint8Array([1]), mimeType: "image/png" })),
}));
vi.mock("@/api/settings", async (orig) => ({
  ...(await orig<typeof import("@/api/settings")>()),
  listBackdrops: () => Promise.resolve([...daemon.images]),
  importBackdrop: daemon.importBackdrop,
  removeBackdrop: daemon.removeBackdrop,
  readBackdrop: daemon.readBackdrop,
}));
const save = vi.hoisted(() => ({ fn: vi.fn<(v: Record<string, string>) => Promise<{ ok: true }>>(() => Promise.resolve({ ok: true as const })) }));
vi.mock("@/stores/settings", async (orig) => ({ ...(await orig<typeof import("@/stores/settings")>()), saveSettings: save.fn }));

const { SettingRow } = await import("./SettingRow");
const { useSettingsStore } = await import("@/stores/settings");
const { resetBackdropCache } = await import("@/stores/backdrops");

const field: SettingFieldView = {
  key: "appearance.backdrop",
  title: "Backdrop",
  description: "",
  group: "appearance",
  type: "enum",
  enumValues: ["forest", "none", "custom"],
  enumLabels: ["Forest", "None", "Custom"],
  defaultValue: "forest",
  restartRequired: false,
  min: 0,
  max: 0,
  placeholder: "",
  page: "appearance",
  section: "window",
  unit: "",
  dependsOn: "",
  row: "",
};

const img = (name: string, addedAt: number): BackdropView => ({ name, size: 10, width: 1920, height: 1080, addedAt });
const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg";

function setValues(backdrop: string, file: string, revision = 1): void {
  useSettingsStore.setState({
    snapshot: { values: { "appearance.backdrop": backdrop, "appearance.backdrop_file": file }, path: "", revision, loadError: "", issues: [], restartPending: [] },
  });
}

async function renderRow() {
  render(<SettingRow field={field} />);
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetBackdropCache();
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  host.hosted = true;
  daemon.images = [img(A, 1), img(B, 2)];
  setValues("custom", A);
});
afterEach(cleanup);

describe("the backdrop row", () => {
  it("shows the select and a thumbnail per image, the shown one marked", async () => {
    await renderRow();
    expect(screen.getByRole("combobox", { name: "Backdrop" }).getAttribute("data-value")).toBe("custom");
    const thumbs = await screen.findAllByTestId("backdrop-thumb");
    expect(thumbs.map((t) => t.dataset.name)).toEqual([A, B]);
    expect(thumbs.map((t) => t.dataset.selected)).toEqual(["true", undefined]);
    expect(screen.getByRole("button", { name: "Show image 1 (1920×1080)" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("marks none while the backdrop is forest", async () => {
    setValues("forest", A);
    await renderRow();
    const thumbs = await screen.findAllByTestId("backdrop-thumb");
    expect(thumbs.every((t) => t.dataset.selected === undefined)).toBe(true);
  });

  it("a click on a thumbnail shows that image", async () => {
    await renderRow();
    fireEvent.click(await screen.findByRole("button", { name: /^Show image 2/ }));
    expect(save.fn).toHaveBeenCalledExactlyOnceWith({ "appearance.backdrop": "custom", "appearance.backdrop_file": B });
  });

  it("a click on the shown one saves nothing", async () => {
    await renderRow();
    fireEvent.click(await screen.findByRole("button", { name: /^Show image 1/ }));
    expect(save.fn).not.toHaveBeenCalled();
  });

  it("× removes the image at once and lists again", async () => {
    daemon.removeBackdrop.mockImplementation((name) => {
      daemon.images = daemon.images.filter((b) => b.name !== name);
      return Promise.resolve();
    });
    await renderRow();
    fireEvent.click(await screen.findByRole("button", { name: "Remove image 2" }));
    expect(daemon.removeBackdrop).toHaveBeenCalledExactlyOnceWith(B);
    await waitFor(() => {
      expect(screen.getAllByTestId("backdrop-thumb").map((t) => t.dataset.name)).toEqual([A]);
    });
  });

  it("Add image… opens the panel in ~/Pictures, imports the first file and lists again", async () => {
    host.pickFiles.mockResolvedValue(["/Users/me/Pictures/sea.webp", "/Users/me/Pictures/other.png"]);
    daemon.importBackdrop.mockImplementation(() => {
      const c = img("cccccccccccccccccccccccccccccccc.webp", 3);
      daemon.images.push(c);
      return Promise.resolve(c);
    });
    await renderRow();
    const add = screen.getByTestId("backdrop-add");
    await waitFor(() => {
      expect(add.hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(add);
    await waitFor(() => {
      expect(screen.getAllByTestId("backdrop-thumb")).toHaveLength(3);
    });
    expect(host.pickFiles).toHaveBeenCalledExactlyOnceWith("/Users/me/Pictures");
    expect(daemon.importBackdrop).toHaveBeenCalledExactlyOnceWith("/Users/me/Pictures/sea.webp");
  });

  it("a cancelled panel imports nothing", async () => {
    host.pickFiles.mockResolvedValue([]);
    await renderRow();
    const add = screen.getByTestId("backdrop-add");
    await waitFor(() => {
      expect(add.hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(add);
    await act(async () => {
      await Promise.resolve();
    });
    expect(daemon.importBackdrop).not.toHaveBeenCalled();
  });

  it("a refusal shows under the gallery with the file's name", async () => {
    host.pickFiles.mockResolvedValue(["/Users/me/Documents/notes.txt"]);
    daemon.importBackdrop.mockRejectedValue(new ConnectError("invalid argument: not a PNG, JPEG, WebP or GIF image (its content is text/plain; charset=utf-8)", Code.InvalidArgument));
    await renderRow();
    const add = screen.getByTestId("backdrop-add");
    await waitFor(() => {
      expect(add.hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(add);
    expect((await screen.findByTestId("setting-error")).textContent).toBe("notes.txt: not a PNG, JPEG, WebP or GIF image (its content is text/plain; charset=utf-8)");
  });

  it("choosing Custom with no image chosen shows the newest one", async () => {
    setValues("forest", "");
    await renderRow();
    await screen.findAllByTestId("backdrop-thumb");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Backdrop" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "Custom" }));
    expect(save.fn).toHaveBeenCalledExactlyOnceWith({ "appearance.backdrop": "custom", "appearance.backdrop_file": B });
  });

  it("choosing Custom keeps the remembered image, and Forest is a plain save", async () => {
    setValues("forest", A);
    await renderRow();
    await screen.findAllByTestId("backdrop-thumb");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Backdrop" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "Custom" }));
    expect(save.fn).toHaveBeenLastCalledWith({ "appearance.backdrop": "custom" });
    // The save lands (the select is disabled while it is in flight).
    await act(async () => {
      setValues("custom", A, 2);
      await Promise.resolve();
    });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Backdrop" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: /^Forest/ }));
    expect(save.fn).toHaveBeenLastCalledWith({ "appearance.backdrop": "forest" });
  });

  it("is disabled outside the app", async () => {
    host.hosted = false;
    await renderRow();
    expect(screen.getByTestId("backdrop-add").hasAttribute("disabled")).toBe(true);
  });

  const options = () => {
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Backdrop" }), { key: "Enter" });
    const out = screen.getAllByRole("option").map((o) => o.textContent);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    return out;
  };
  const shown = () => screen.getByRole("combobox", { name: "Backdrop" }).getAttribute("data-value");

  it.each([
    { name: "no images: no Custom", images: [] as string[], backdrop: "forest", file: "", want: ["Forest (default)", "None"], value: "forest" },
    { name: "an image: Custom listed", images: [A], backdrop: "forest", file: "", want: ["Forest (default)", "None", "Custom"], value: "forest" },
    { name: "custom with no file and no images shows Forest", images: [], backdrop: "custom", file: "", want: ["Forest (default)", "None"], value: "forest" },
    { name: "custom with its image gone shows Forest", images: [B], backdrop: "custom", file: A, want: ["Forest (default)", "None", "Custom"], value: "forest" },
    { name: "custom with its image listed", images: [A], backdrop: "custom", file: A, want: ["Forest (default)", "None", "Custom"], value: "custom" },
  ])("$name", async ({ images, backdrop, file, want, value }) => {
    daemon.images = images.map((n, i) => img(n, i));
    setValues(backdrop, file);
    await renderRow();
    await waitFor(() => {
      expect(shown()).toBe(value);
    });
    expect(options()).toEqual(want);
  });

  it("removing the shown image shows Forest and drops Custom when it was the last", async () => {
    daemon.images = [img(A, 1)];
    daemon.removeBackdrop.mockImplementation((name) => {
      daemon.images = daemon.images.filter((b) => b.name !== name);
      return Promise.resolve();
    });
    await renderRow();
    await screen.findAllByTestId("backdrop-thumb");
    expect(shown()).toBe("custom");
    fireEvent.click(screen.getByRole("button", { name: "Remove image 1" }));
    // The list comes back before the daemon's fallback snapshot: Forest already.
    await waitFor(() => {
      expect(screen.queryByTestId("backdrop-gallery")).toBeNull();
    });
    expect(shown()).toBe("forest");
    expect(options()).toEqual(["Forest (default)", "None"]);
    // Then the snapshot (the daemon cleared the file and fell back) changes nothing shown.
    act(() => {
      setValues("forest", "", 2);
    });
    expect(shown()).toBe("forest");
    expect(save.fn).not.toHaveBeenCalled();
  });

  it("removing another image keeps the shown one", async () => {
    daemon.removeBackdrop.mockImplementation((name) => {
      daemon.images = daemon.images.filter((b) => b.name !== name);
      return Promise.resolve();
    });
    await renderRow();
    fireEvent.click(await screen.findByRole("button", { name: "Remove image 2" }));
    await waitFor(() => {
      expect(screen.getAllByTestId("backdrop-thumb")).toHaveLength(1);
    });
    expect(shown()).toBe("custom");
    expect(save.fn).not.toHaveBeenCalled();
  });

  it("with no images there is no gallery, only the button", async () => {
    daemon.images = [];
    setValues("forest", "");
    await renderRow();
    expect(screen.queryByTestId("backdrop-gallery")).toBeNull();
    expect(screen.getByTestId("backdrop-add")).toBeTruthy();
  });
});
