import { StrictMode, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { create } from "zustand";
import { ColourPicker } from "./ColourPicker";

// The picker keeps its own OKLCH beside the hex it was given, because a hex cannot hold the
// hue of a grey (or the exact lightness and chroma it came from). These pin how that local
// state follows the value prop: its own echo, an outside change, and a store parent.

const field = (name: string) => screen.getByRole<HTMLInputElement>("textbox", { name: `Accent ${name}` });
const hex = () => screen.getByTestId<HTMLInputElement>("colour-hex");

function commit(name: string, v: string) {
  const el = field(name);
  fireEvent.change(el, { target: { value: v } });
  fireEvent.keyDown(el, { key: "Enter" });
}

/** A parent that holds the value in React state and passes every change back. */
function Held({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ColourPicker label="Accent" value={value} onChange={setValue} />
      <button
        type="button"
        data-testid="outside"
        onClick={() => {
          setValue("#808080");
        }}
      />
    </>
  );
}

beforeAll(() => {
  // jsdom has no layout or pointer capture: the plane is 100 × 100 at the origin and holds the pointer.
  Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.hasPointerCapture = () => true;
  Element.prototype.releasePointerCapture = () => undefined;
  // No canvas in jsdom: the plane and strips are not painted.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});
afterEach(() => {
  cleanup();
});

describe("ColourPicker", () => {
  it("keeps the hue of a grey it made", () => {
    render(
      <StrictMode>
        <Held initial="#3366cc" />
      </StrictMode>,
    );
    commit("hue", "200");
    commit("chroma", "0");
    expect(field("chroma").value).toBe(".000");
    expect(field("hue").value).toBe("200");
    // The hex is a grey, which says nothing of a hue.
    const [r, g, b] = [hex().value.slice(1, 3), hex().value.slice(3, 5), hex().value.slice(5, 7)];
    expect(new Set([r, g, b]).size).toBe(1);
  });

  it("takes a value from outside, keeping its hue when that value is a grey", () => {
    const { rerender } = render(<ColourPicker label="Accent" value="#3366cc" onChange={() => undefined} />);
    commit("hue", "120");
    // The parent dropped that change and then sent a new colour: the fields follow it.
    rerender(<ColourPicker label="Accent" value="#cc3366" onChange={() => undefined} />);
    expect(hex().value).toBe("#cc3366");
    const hue = Number(field("hue").value);
    expect(hue).toBeGreaterThan(0);
    expect(hue).not.toBe(120);
    rerender(<ColourPicker label="Accent" value="#808080" onChange={() => undefined} />);
    expect(field("chroma").value).toBe(".000");
    expect(field("hue").value).toBe(String(hue));
  });

  it("an outside grey keeps the hue the picker showed", () => {
    render(<Held initial="#3366cc" />);
    commit("hue", "42");
    fireEvent.click(screen.getByTestId("outside"));
    expect(hex().value).toBe("#808080");
    expect(field("hue").value).toBe("42");
  });

  it("dragging under a store parent keeps what was dragged, not the hex read back", () => {
    // The theme editor's parents write a zustand store, as here.
    const useValue = create<{ value: string }>(() => ({ value: "#3366cc" }));
    function StoreParent() {
      const value = useValue((s) => s.value);
      return (
        <ColourPicker
          label="Accent"
          value={value}
          onChange={(v) => {
            useValue.setState({ value: v });
          }}
        />
      );
    }
    render(
      <StrictMode>
        <StoreParent />
      </StrictMode>,
    );
    commit("hue", "200");
    const plane = screen.getByTestId("colour-plane");
    fireEvent.pointerDown(plane, { pointerId: 1, clientX: 1, clientY: 50 });
    // A low chroma, where the hex read back drifts from what the plane gave.
    fireEvent.pointerMove(plane, { pointerId: 1, clientX: 2, clientY: 40 });
    expect(field("hue").value).toBe("200");
    expect(field("chroma").value).toBe(".007");
    expect(field("lightness").value).toBe("60");
  });
});
