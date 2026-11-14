import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { LayoutSchema } from "@/gen/codefoundry/v1/layout_pb";
import { toLayoutView, type LayoutView } from "@/api/layout";
import { applyLayoutEvent, resetLayout, useLayoutStore } from "@/stores/layout";
import { layoutOf, pane, space, tab } from "@/test/shellLayout";
import { resetLayoutService, useLayoutServiceStore } from "@/shell/layoutService";
import { NEWER_LAYOUT_TEXT, NewerLayoutLine, ShellNotice } from "./ShellNotice";

const restarts = vi.fn(() => Promise.resolve());
vi.mock("@/shell/layoutService", async (orig) => ({ ...(await orig<typeof import("@/shell/layoutService")>()), restartOldDaemon: () => restarts() }));

const NEWER = ['space sp-a: tab t-9 of kind "notebook"'];

function snapshot(l: LayoutView): void {
  act(() => {
    applyLayoutEvent({ kind: "snapshot", rev: l.rev, layout: l, clientId: "" });
  });
}

afterEach(() => {
  cleanup();
  resetLayout();
  resetLayoutService();
  restarts.mockClear();
});

describe("the no-layout notice", () => {
  it("waits, until the daemon says it has no layout service: then what is wrong, and Restart Now", () => {
    render(<ShellNotice kind="no-layout" />);
    expect(screen.getByTestId("shell-notice").textContent).toBe("Waiting for the daemon to send this window's layout…");
    expect(screen.queryByRole("button")).toBeNull();

    act(() => {
      useLayoutServiceStore.setState({ missing: true });
    });
    expect(screen.getByRole("heading").textContent).toBe("The running daemon is older than this window");
    expect(screen.queryByText(/Waiting for the daemon/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restart Now" }));
    expect(restarts).toHaveBeenCalledTimes(1);

    // Sent: the button says so and does nothing more; a failure shows why and the button again.
    act(() => {
      useLayoutServiceStore.setState({ restarting: true });
    });
    const busy = screen.getByRole("button", { name: "Restarting…" });
    expect(busy.hasAttribute("disabled")).toBe(true);
    act(() => {
      useLayoutServiceStore.setState({ restarting: false, error: "this daemon cannot restart itself" });
    });
    expect(screen.getByTestId("shell-old-daemon-error").textContent).toBe("this daemon cannot restart itself");
    expect(screen.getByRole("button", { name: "Restart Now" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("the newer build's layout line", () => {
  it("reads Layout.newer from the daemon", () => {
    expect(toLayoutView(create(LayoutSchema, { newer: NEWER })).newer).toEqual(NEWER);
    expect(toLayoutView(create(LayoutSchema, {})).newer).toEqual([]);
  });

  it("says once, quietly, that changes are not saved, for as long as the daemon says so", () => {
    const l = layoutOf([space(pane("p-1", [tab("t-1", "prs")]), "p-1")], 3);
    render(<NewerLayoutLine />);
    snapshot(l);
    expect(screen.queryByTestId("shell-newer-layout")).toBeNull();

    snapshot({ ...l, rev: 4, newer: NEWER });
    const line = screen.getByTestId("shell-newer-layout");
    expect(line.textContent).toBe(NEWER_LAYOUT_TEXT);
    expect(line.getAttribute("role")).toBe("status");
    // A status line, never a dialog or a button to press.
    expect(line.querySelector("button")).toBeNull();

    // A delta never carries it: the daemon decided it at load, and it stays.
    act(() => {
      applyLayoutEvent({
        kind: "delta",
        rev: 5,
        delta: { spaces: [], removedSpaceIds: [], spaceOrder: ["sp-a"], currentSpaceId: "sp-a", defaultSpaceId: "sp-a", threads: [], removedThreadIds: [], legacyImported: true },
        clientId: "",
      });
    });
    expect(useLayoutStore.getState()).toMatchObject({ rev: 5, newerBuild: true });
    expect(screen.getByTestId("shell-newer-layout")).toBeTruthy();

    // A daemon that loads a layout of its own build (after an update) sends a snapshot without it.
    snapshot({ ...l, rev: 1 });
    expect(screen.queryByTestId("shell-newer-layout")).toBeNull();
  });
});
