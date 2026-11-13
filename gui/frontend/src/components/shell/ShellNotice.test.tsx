import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { LayoutSchema } from "@/gen/codefoundry/v1/layout_pb";
import { toLayoutView, type LayoutView } from "@/api/layout";
import { applyLayoutEvent, resetLayout, useLayoutStore } from "@/stores/layout";
import { layoutOf, pane, space, tab } from "@/test/shellLayout";
import { NEWER_LAYOUT_TEXT, NewerLayoutLine } from "./ShellNotice";

const NEWER = ['space sp-a: tab t-9 of kind "notebook"'];

function snapshot(l: LayoutView): void {
  act(() => {
    applyLayoutEvent({ kind: "snapshot", rev: l.rev, layout: l, clientId: "" });
  });
}

afterEach(() => {
  cleanup();
  resetLayout();
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
