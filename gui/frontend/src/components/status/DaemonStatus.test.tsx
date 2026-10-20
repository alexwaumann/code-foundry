import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useEventsStore } from "@/stores/events";
import { useHealthStore } from "@/stores/health";
import { DaemonStatus } from "./DaemonStatus";

afterEach(cleanup);

describe("DaemonStatus", () => {
  it("shows the dot and version; pid and uptime go to the tooltip label", () => {
    useHealthStore.setState({ status: "ok", health: { pid: 4242, version: "1.2.3", uptimeSeconds: 249 }, error: null });
    useEventsStore.setState({ stream: "open" });
    render(<DaemonStatus />);
    expect(screen.getByTestId("version").textContent).toBe("1.2.3");
    expect(screen.getByTestId("status").dataset.status).toBe("ok");
    expect(screen.getByTestId("daemon-status").textContent).toBe("1.2.3");
    expect(screen.getByTestId("daemon-status").getAttribute("aria-label")).toBe("daemon · pid 4242 · up 4m 9s");
    expect(screen.queryByText(/syncing/)).toBeNull();
  });

  it("renders a tip build as vX.Y.Z (tip N)", () => {
    useHealthStore.setState({ status: "ok", health: { pid: 1, version: "v0.15.0-tip.3", uptimeSeconds: 1 }, error: null });
    useEventsStore.setState({ stream: "open" });
    render(<DaemonStatus />);
    expect(screen.getByTestId("version").textContent).toBe("v0.15.0 (tip 3)");
  });

  it("says so while the events stream is not open", () => {
    useHealthStore.setState({ status: "ok", health: { pid: 1, version: "dev", uptimeSeconds: 1 }, error: null });
    useEventsStore.setState({ stream: "retrying" });
    render(<DaemonStatus />);
    expect(screen.getByText("syncing events…")).toBeDefined();
  });

  it("shows a red dot with the error in the label when the daemon is down", () => {
    useHealthStore.setState({ status: "error", health: null, error: "connect failed" });
    render(<DaemonStatus />);
    expect(screen.getByTestId("status").dataset.status).toBe("error");
    expect(screen.queryByTestId("version")).toBeNull();
    expect(screen.getByTestId("daemon-status").getAttribute("aria-label")).toBe("daemon unreachable · connect failed");
  });
});
