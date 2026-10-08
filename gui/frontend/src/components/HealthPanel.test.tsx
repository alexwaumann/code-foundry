import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useHealthStore } from "@/stores/health";
import { HealthPanel } from "./HealthPanel";

afterEach(cleanup);

describe("HealthPanel", () => {
  it("renders pid, version, and uptime from the health store", () => {
    useHealthStore.setState({
      status: "ok",
      health: { pid: 4242, version: "1.2.3", uptimeSeconds: 249 },
      error: null,
    });
    render(<HealthPanel />);
    expect(screen.getByText("4242")).toBeDefined();
    expect(screen.getByText("1.2.3")).toBeDefined();
    expect(screen.getByText("4m 9s")).toBeDefined();
    expect(screen.getByTestId("status").textContent).toBe("ok");
  });

  it("shows the error when the daemon is unreachable", () => {
    useHealthStore.setState({ status: "error", health: null, error: "connect failed" });
    render(<HealthPanel />);
    expect(screen.getByRole("alert").textContent).toBe("connect failed");
  });
});
