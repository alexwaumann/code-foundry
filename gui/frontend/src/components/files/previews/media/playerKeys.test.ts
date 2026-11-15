import { describe, expect, it } from "vitest";
import { playerKeyAction, type PlayerKeyEvent } from "./playerKeys";

const el = (html: string) => {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.querySelector("[data-target]") ?? host;
};
const key = (k: string, over: Partial<PlayerKeyEvent> = {}): PlayerKeyEvent => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, target: el('<div data-target tabindex="0"></div>'), ...over });

describe("playerKeyAction", () => {
  it.each<[string, ReturnType<typeof playerKeyAction>]>([
    [" ", "toggle"],
    ["ArrowLeft", "back"],
    ["ArrowRight", "forward"],
    ["ArrowUp", "louder"],
    ["ArrowDown", "quieter"],
    ["m", "mute"],
    ["M", "mute"],
    ["f", "fullscreen"],
    ["k", null],
    ["Enter", null],
    ["Escape", null],
  ])("%j → %s", (k, want) => {
    expect(playerKeyAction(key(k), true)).toBe(want);
  });

  it("leaves every chord with a modifier to the window's keymap", () => {
    for (const mod of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) {
      expect(playerKeyAction(key("f", { [mod]: true }), true)).toBeNull();
      expect(playerKeyAction(key("ArrowLeft", { [mod]: true }), true)).toBeNull();
    }
  });

  it("leaves what something inside took, typing, menus, and Space on a button", () => {
    expect(playerKeyAction(key("ArrowLeft", { defaultPrevented: true }), true)).toBeNull();
    expect(playerKeyAction(key(" ", { isComposing: true }), true)).toBeNull();
    expect(playerKeyAction(key("m", { target: el("<input data-target>") }), true)).toBeNull();
    expect(playerKeyAction(key("m", { target: el('<div role="menu"><div role="menuitemradio" data-target></div></div>') }), true)).toBeNull();
    expect(playerKeyAction(key(" ", { target: el('<button data-target aria-label="Full screen"></button>') }), true)).toBeNull();
    // A slider's Space is ours: it has no press of its own.
    expect(playerKeyAction(key(" ", { target: el('<span role="slider" tabindex="0" data-target></span>') }), true)).toBe("toggle");
  });

  it("F only where full screen is offered (audio, a webview that refuses it)", () => {
    expect(playerKeyAction(key("f"), false)).toBeNull();
  });
});
