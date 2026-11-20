import { afterEach, describe, expect, it } from "vitest";

import { heldByModal } from "./modalFocus";

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("heldByModal", () => {
  const cases: { name: string; html: string; want: boolean }[] = [
    { name: "an open dialog over the surface", html: '<div id="root"></div><div role="dialog" data-state="open"><button id="el"></button></div>', want: true },
    { name: "an open alert dialog over the surface", html: '<div id="root"></div><div role="alertdialog" data-state="open"><button id="el"></button></div>', want: true },
    { name: "a dialog that is closing", html: '<div id="root"></div><div role="dialog" data-state="closed"><button id="el"></button></div>', want: false },
    { name: "the command palette", html: '<div id="root"></div><div role="dialog" data-state="open" data-region="palette"><input id="el" /></div>', want: false },
    { name: "a dialog that holds the surface", html: '<div role="dialog" data-state="open"><div id="root"></div><button id="el"></button></div>', want: false },
    { name: "an element outside any dialog", html: '<div id="root"></div><button id="el"></button>', want: false },
  ];
  it.each(cases)("$name: $want", ({ html, want }) => {
    const host = mount(html);
    expect(heldByModal(host.querySelector("#el"), host.querySelector("#root"))).toBe(want);
  });

  it("is false with nothing focused", () => {
    expect(heldByModal(null, document.body)).toBe(false);
  });
});
