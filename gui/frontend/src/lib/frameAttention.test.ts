import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchFrameAttention, type FrameAttention } from "./frameAttention";

describe("watchFrameAttention", () => {
  let frame: HTMLIFrameElement;
  let composer: HTMLInputElement;
  let attention: FrameAttention;
  let hover = false;

  /** Focus moves into the frame, as the window sees it. */
  const enterFrame = () => {
    frame.focus();
    window.dispatchEvent(new FocusEvent("blur"));
  };
  const typeInComposer = () => {
    composer.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
  };

  beforeEach(() => {
    hover = false;
    composer = document.body.appendChild(document.createElement("input"));
    frame = document.body.appendChild(document.createElement("iframe"));
    frame.tabIndex = 0;
    vi.spyOn(frame, "matches").mockImplementation((s) => s === ":hover" && hover);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    attention = watchFrameAttention(() => frame);
  });

  afterEach(() => {
    attention.stop();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("is not there while the focus is elsewhere, even with the pointer over the frame", () => {
    hover = true;
    typeInComposer();
    expect(attention.present()).toBe(false);
  });

  it("is there when the pointer took the focus in, and stays as the pointer moves off", () => {
    hover = true;
    enterFrame();
    expect(attention.present()).toBe(true);
    hover = false;
    expect(attention.present()).toBe(true);
  });

  it("is there when Tab took the focus in", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    enterFrame();
    expect(attention.present()).toBe(true);
  });

  it("is not there when the frame took the focus for itself", () => {
    typeInComposer();
    enterFrame();
    expect(attention.present()).toBe(false);
  });

  it("is there once the pointer comes to a frame that has the focus", () => {
    typeInComposer();
    enterFrame();
    hover = true;
    expect(attention.present()).toBe(true);
  });

  it("forgets how the focus came in once it leaves", () => {
    hover = true;
    enterFrame();
    hover = false;
    composer.focus();
    enterFrame();
    expect(attention.present()).toBe(false);
  });

  it("is not there while another app has the focus", () => {
    hover = true;
    enterFrame();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    expect(attention.present()).toBe(false);
  });

  it("is not there with no frame", () => {
    const none = watchFrameAttention(() => null);
    expect(none.present()).toBe(false);
    none.stop();
  });
});
