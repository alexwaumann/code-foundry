import { act, cleanup, render } from "@testing-library/react";
import { SquareArrowOutUpRight } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

const listAppIcons = vi.hoisted(() => vi.fn());
vi.mock("@/api/gitops", async (orig) => ({
  ...(await orig<typeof import("@/api/gitops")>()),
  listAppIcons,
}));
const { pngDataUrl } = await import("@/api/gitops");
const { requestAppIcon, resetAppIconsForTests, useAppIconsStore } = await import("@/stores/appIcons");
const { AppIcon, FinderIcon } = await import("./AppIcon");

const FINDER = "data:image/png;base64,RklOREVS";

afterEach(() => {
  cleanup();
  resetAppIconsForTests();
  listAppIcons.mockReset();
});

describe("pngDataUrl", () => {
  it("base64-encodes the bytes, past one chunk too", () => {
    expect(pngDataUrl(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("data:image/png;base64,iVBORw==");
    const big = new Uint8Array(0x8000 * 2 + 3).fill(65);
    expect(atob(pngDataUrl(big).split(",")[1] ?? "")).toBe("A".repeat(big.length));
  });
});

describe("app icons", () => {
  it("asks once per tick for every id, once per session, and records misses", async () => {
    listAppIcons.mockResolvedValue(new Map([["com.apple.finder", FINDER]]));
    requestAppIcon("com.apple.finder");
    requestAppIcon("dev.zed.Zed");
    requestAppIcon("com.apple.finder");
    await vi.waitFor(() => {
      expect(useAppIconsStore.getState().urls).toEqual({ "com.apple.finder": FINDER, "dev.zed.Zed": null });
    });
    expect(listAppIcons.mock.calls).toEqual([[["com.apple.finder", "dev.zed.Zed"]]]);
    requestAppIcon("dev.zed.Zed");
    requestAppIcon("");
    await Promise.resolve();
    expect(listAppIcons).toHaveBeenCalledTimes(1);
  });

  it("asks again after a failed request", async () => {
    listAppIcons.mockRejectedValueOnce(new Error("boom"));
    requestAppIcon("com.apple.finder");
    await vi.waitFor(() => {
      expect(listAppIcons).toHaveBeenCalledTimes(1);
    });
    listAppIcons.mockResolvedValue(new Map([["com.apple.finder", FINDER]]));
    await vi.waitFor(() => {
      requestAppIcon("com.apple.finder");
      expect(useAppIconsStore.getState().urls["com.apple.finder"]).toBe(FINDER);
    });
  });

  it("shows the fallback until the icon loads, then the icon in an svg slots size alike", async () => {
    let answer: (m: Map<string, string>) => void = () => undefined;
    listAppIcons.mockReturnValue(new Promise((r) => (answer = r)));
    const { container } = render(
      <>
        <FinderIcon className="size-3" />
        <AppIcon bundleId="dev.zed.Zed" fallback={SquareArrowOutUpRight} />
      </>,
    );
    const [finder, zed] = container.querySelectorAll("svg");
    expect(finder?.classList.contains("lucide-folder")).toBe(true);
    expect(zed?.classList.contains("lucide-square-arrow-out-up-right")).toBe(true);
    await act(async () => {
      answer(new Map([["com.apple.finder", FINDER]]));
      await Promise.resolve();
    });
    const icon = container.querySelector("svg[data-app-icon='com.apple.finder']");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.classList.contains("size-3")).toBe(true);
    expect(icon?.querySelector("image")?.getAttribute("href")).toBe(FINDER);
    // No icon for Zed: the fallback stays.
    expect(container.querySelector("svg.lucide-square-arrow-out-up-right")).not.toBeNull();
  });
});
