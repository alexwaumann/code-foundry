import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LineageNote } from "./LineageNote";

afterEach(cleanup);

const NOW = Date.now();

describe("LineageNote", () => {
  it("is one static line: icon, content and age, no chevron or body", () => {
    render(
      <LineageNote icon={<svg data-testid="icon" />} atMs={NOW - 18 * 60_000} testId="n">
        <span className="lead">Created by</span>
      </LineageNote>,
    );
    const line = screen.getByTestId("n-line");
    expect(screen.getByTestId("n").getAttribute("role")).toBe("note");
    expect(line.getAttribute("role")).toBeNull();
    expect(line.getAttribute("aria-expanded")).toBeNull();
    expect(screen.getByTestId("icon")).toBeTruthy();
    expect(screen.getByTestId("n-age").textContent).toBe("18 min ago");
    expect(line.querySelector(".chev")).toBeNull();
    fireEvent.click(line);
    expect(screen.queryByTestId("n-body")).toBeNull();
  });

  it("has no age without a time", () => {
    render(
      <LineageNote icon={null} atMs={null} testId="n">
        x
      </LineageNote>,
    );
    expect(screen.queryByTestId("n-age")).toBeNull();
  });

  it("with a body: a chevron, collapsed, then the code block once opened (click or keyboard)", () => {
    const code = '{\n  "thread_id": "s-1",\n  "status": "idle"\n}';
    render(
      <LineageNote icon={null} atMs={NOW} body={{ label: "Wake payload", lang: "json", code }} testId="n">
        <span>Woken by x</span>
      </LineageNote>,
    );
    const line = screen.getByTestId("n-line");
    expect(line.getAttribute("role")).toBe("button");
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(line.querySelector(".chev")).not.toBeNull();
    expect(screen.queryByTestId("n-body")).toBeNull();

    fireEvent.click(line);
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("n").getAttribute("data-open")).toBe("true");
    const body = screen.getByTestId("n-body");
    expect(body.querySelector(".lhead")?.textContent).toBe("Wake payloadJSON");
    expect(body.querySelector("pre")?.textContent).toBe(code);
    expect(body.querySelector("pre")?.getAttribute("data-lang")).toBe("json");

    fireEvent.keyDown(line, { key: "Enter" });
    expect(screen.queryByTestId("n-body")).toBeNull();
    fireEvent.keyDown(line, { key: " " });
    expect(screen.getByTestId("n-body")).toBeTruthy();
  });

  it("can start open", () => {
    render(
      <LineageNote icon={null} atMs={null} body={{ label: "Payload", lang: "", code: "x" }} defaultOpen testId="n">
        y
      </LineageNote>,
    );
    expect(screen.getByTestId("n-body").querySelector(".lang")).toBeNull();
  });
});
