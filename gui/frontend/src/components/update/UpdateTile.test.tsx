import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UpdateStateView, UpdateStatusView } from "@/api/update";
import { tooltipText } from "@/test/tooltip";

const { UpdateIndicator, UpdateTile } = await import("./UpdateIndicator");
const { useUpdateStore } = await import("@/stores/update");

/**
 * The rail's update tile (docs/notes/sidebar-rail.md): the expanded footer's chip as an icon,
 * from the same badge and tone table, its words in the tooltip, its click the chip's.
 */

function status(state: UpdateStateView, over: Partial<UpdateStatusView> = {}): UpdateStatusView {
  return {
    state,
    currentVersion: "v0.1.0",
    enabled: true,
    disabledReason: "",
    releaseRepo: "",
    channel: "stable",
    checking: false,
    lastCheckedAt: null,
    lastCheckError: "",
    latestVersion: "",
    targetVersion: state === "idle" ? "" : "v0.2.0",
    notesUrl: "",
    progress: "",
    failureReason: "",
    ...over,
  };
}

function show(st: UpdateStatusView | null) {
  useUpdateStore.setState({ status: st, guiVersion: null, dialogOpen: false });
  render(
    <>
      <UpdateTile />
      <UpdateIndicator />
    </>,
  );
}

const tile = () => screen.queryByTestId("update-tile");

beforeEach(() => {
  useUpdateStore.setState({ status: null, guiVersion: null, dialogOpen: false, pending: null, restarting: null, error: null });
});
afterEach(() => {
  cleanup();
});

describe("the rail's update tile", () => {
  it.each([
    ["available", "available", "bg-cf-update-surface", "lucide-download", "v0.2.0 availableDownload"],
    ["downloading", "downloading", "bg-cf-update-surface", "lucide-download", "Downloading v0.2.0…"],
    ["downloaded", "downloaded", "bg-cf-success-surface", "lucide-refresh-cw", "v0.2.0 downloadedRestart to apply"],
    ["failed", "failed", "bg-cf-error-surface", "lucide-triangle-alert", "Update failedDetails"],
    ["installed", "installed", "bg-cf-success-surface", "lucide-refresh-cw", "v0.2.0 installedRestart to apply"],
  ] as const)("%s: the chip's kind, tone and icon, no text; its words in the tooltip", (state, kind, toneClass, lucide, tip) => {
    show(status(state));
    const el = tile() as HTMLElement;
    const chip = screen.getByTestId("update-indicator");
    expect(el.dataset.kind).toBe(kind);
    expect(el.dataset.kind).toBe(chip.dataset.kind);
    expect(el.className).toContain(toneClass);
    expect(el.querySelector("svg")?.getAttribute("class")).toContain(lucide);
    expect(el.textContent).toBe("");
    expect(tooltipText(el)).toBe(tip);
  });

  it("is named with the chip's words for a screen reader", () => {
    show(status("downloaded"));
    expect(tile()?.getAttribute("aria-label")).toBe("v0.2.0 downloaded · Restart to apply");
  });

  it("a click opens the update dialog, as the chip's does", () => {
    show(status("downloaded"));
    fireEvent.click(tile() as HTMLElement);
    expect(useUpdateStore.getState().dialogOpen).toBe(true);
  });

  it("none while there is no update; it comes and goes with the status", () => {
    show(null);
    expect(tile()).toBeNull();
    act(() => {
      useUpdateStore.setState({ status: status("idle") });
    });
    expect(tile()).toBeNull();
    act(() => {
      useUpdateStore.setState({ status: status("downloading") });
    });
    expect(tile()?.dataset.kind).toBe("downloading");
  });
});
