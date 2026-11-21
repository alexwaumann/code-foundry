import { afterEach, describe, expect, it, vi } from "vitest";

const setHostZoom = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/api/app", () => ({ setHostZoom }));

import { useUiStore } from "@/stores/ui";
import { applyZoom, startZoomSync } from "./zoom";

afterEach(() => {
  setHostZoom.mockClear();
  useUiStore.setState({ zoom: 100 });
});

describe("the window zoom", () => {
  it("is the host's: the page gets no CSS zoom, only the percent on <html>", () => {
    applyZoom(125);
    expect(setHostZoom).toHaveBeenCalledWith(125);
    expect(document.documentElement.dataset.zoom).toBe("125");
    expect(document.documentElement.style.zoom).toBeFalsy();
  });

  it("follows the store: applied on start, then on each change, and not when it stays the same", () => {
    const onChange = vi.fn();
    const stop = startZoomSync(onChange);
    expect(setHostZoom).toHaveBeenLastCalledWith(100);
    useUiStore.setState({ zoom: 150 });
    expect(setHostZoom).toHaveBeenLastCalledWith(150);
    expect(onChange).toHaveBeenCalledTimes(1);
    useUiStore.setState({ zoom: 150 });
    expect(setHostZoom).toHaveBeenCalledTimes(2);
    stop();
    useUiStore.setState({ zoom: 90 });
    expect(setHostZoom).toHaveBeenCalledTimes(2);
  });
});
