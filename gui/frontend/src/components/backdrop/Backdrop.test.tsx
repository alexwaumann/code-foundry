// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ReadBackdrop: each name resolves when the test says so.
const daemon = vi.hoisted(() => ({
  pending: new Map<string, (v: { data: Uint8Array; mimeType: string } | null) => void>(),
}));
vi.mock("@/api/settings", async (orig) => ({
  ...(await orig<typeof import("@/api/settings")>()),
  readBackdrop: (name: string) =>
    new Promise((resolve) => {
      daemon.pending.set(name, resolve);
    }),
}));

const { Backdrop } = await import("./Backdrop");
const { useSettingsStore } = await import("@/stores/settings");
const { resetBackdropCache } = await import("@/stores/backdrops");

function setValues(values: Record<string, string>): void {
  useSettingsStore.setState({ snapshot: { values, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
}

async function answer(name: string, found: boolean): Promise<void> {
  await act(async () => {
    daemon.pending.get(name)?.(found ? { data: new Uint8Array([137, 80]), mimeType: "image/png" } : null);
    await Promise.resolve();
  });
}

const art = () => screen.queryByTestId("backdrop");
const vars = () => {
  const el = art()?.firstElementChild as HTMLElement | null;
  return [el?.style.getPropertyValue("--cf-backdrop-narrow"), el?.style.getPropertyValue("--cf-backdrop-wide")];
};

const createUrl = vi.fn<(b: Blob) => string>();

beforeEach(() => {
  resetBackdropCache();
  daemon.pending.clear();
  let n = 0;
  createUrl.mockReset().mockImplementation(() => `blob:img-${String(++n)}`);
  URL.createObjectURL = createUrl;
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe("Backdrop", () => {
  it("forest is the bundled art, also before any snapshot", () => {
    useSettingsStore.setState({ snapshot: null });
    render(<Backdrop />);
    expect(art()?.dataset.backdrop).toBe("forest");
  });

  it("none renders nothing", () => {
    setValues({ "appearance.backdrop": "none" });
    render(<Backdrop />);
    expect(art()).toBeNull();
  });

  it("custom renders nothing while loading, then the image for both aspect ratios", async () => {
    setValues({ "appearance.backdrop": "custom", "appearance.backdrop_file": "a.png" });
    render(<Backdrop />);
    expect(art()).toBeNull();
    await answer("a.png", true);
    expect(art()?.dataset.backdrop).toBe("custom");
    expect(vars()).toEqual(['url("blob:img-1")', 'url("blob:img-1")']);
  });

  it("custom fetches a name once for every view", async () => {
    setValues({ "appearance.backdrop": "custom", "appearance.backdrop_file": "a.png" });
    render(<Backdrop />);
    await answer("a.png", true);
    render(<Backdrop />);
    expect(screen.getAllByTestId("backdrop")).toHaveLength(2);
    expect(createUrl).toHaveBeenCalledTimes(1);
  });

  it("custom with a file gone from the folder renders nothing", async () => {
    setValues({ "appearance.backdrop": "custom", "appearance.backdrop_file": "gone.png" });
    render(<Backdrop />);
    await answer("gone.png", false);
    expect(art()).toBeNull();
  });

  it("custom with no file renders nothing and asks for nothing", () => {
    setValues({ "appearance.backdrop": "custom", "appearance.backdrop_file": "" });
    render(<Backdrop />);
    expect(art()).toBeNull();
    expect(daemon.pending.size).toBe(0);
  });
});
