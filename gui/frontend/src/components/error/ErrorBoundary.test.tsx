import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";
import { AppError, PaneError } from "./fallbacks";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let broken = true;
function Flaky() {
  if (broken) throw new Error("bad shape");
  return <p>surface</p>;
}

describe("ErrorBoundary", () => {
  it("a pane shows the error and Try again renders it again", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    broken = true;
    render(
      <ErrorBoundary label="test pane" fallback={PaneError}>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("pane-error").textContent).toContain("could not render");
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("surface")).toBeTruthy();
  });

  it("the app root shows the error text and a Reload button", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    broken = true;
    render(
      <ErrorBoundary label="app" fallback={AppError}>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("app-error").textContent).toContain("bad shape");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });
});
