import type * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { itemLeaveWhileClosing } from "./menuItemLeave";

/** An item inside a role=menu with this data-state, and a pointerleave on it. */
function leave(state: "open" | "closed", dialog = false) {
  document.body.replaceChildren();
  if (dialog) {
    const d = document.createElement("div");
    d.setAttribute("role", "dialog");
    document.body.append(d);
  }
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("data-state", state);
  const item = document.createElement("div");
  menu.append(item);
  const preventDefault = vi.fn();
  const own = vi.fn();
  itemLeaveWhileClosing(own)({ currentTarget: item, preventDefault } as unknown as React.PointerEvent<HTMLElement>);
  return { preventDefault, own };
}

describe("itemLeaveWhileClosing", () => {
  it("leaves an open menu's pointerleave to Radix (it focuses the content)", () => {
    const { preventDefault, own } = leave("open");
    expect(preventDefault).not.toHaveBeenCalled();
    expect(own).toHaveBeenCalledOnce();
  });

  it("stops it while the menu animates out under a dialog, so the dialog the item opened keeps its focus", () => {
    const { preventDefault, own } = leave("closed", true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(own).toHaveBeenCalledOnce();
  });

  it("leaves a closing menu's pointerleave alone with no dialog (a menu reopened mid-fade wants that focus)", () => {
    const { preventDefault, own } = leave("closed");
    expect(preventDefault).not.toHaveBeenCalled();
    expect(own).toHaveBeenCalledOnce();
  });
});
