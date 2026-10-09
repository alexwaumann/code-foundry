import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar } from "./Avatar";

afterEach(cleanup);

describe("Avatar", () => {
  it("loads a login's GitHub avatar", () => {
    const { container } = render(<Avatar login="teammate-kim" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://github.com/teammate-kim.png?size=64");
  });

  it("shows only the initial of a git author name without a login (no lookup by name)", () => {
    const { container } = render(<Avatar login="" name="Alex" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });

  it("shows ? for a deleted account", () => {
    const { container } = render(<Avatar login="" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("?");
  });
});
