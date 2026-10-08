import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useEventsStore } from "@/stores/events";
import { useHealthStore } from "@/stores/health";
import { DaemonStatus } from "./DaemonStatus";

afterEach(cleanup);

describe("DaemonStatus", () => {
  it("renders pid, version, and uptime from the health store", () => {
    useHealthStore.setState({ status: "ok", health: { pid: 4242, version: "1.2.3", uptimeSeconds: 249 }, error: null });
    useEventsStore.setState({ stream: "open" });
    render(<DaemonStatus />);
    expect(screen.getByTestId("pid").textContent).toBe("4242");
    expect(screen.getByTestId("version").textContent).toBe("1.2.3");
    expect(screen.getByTestId("uptime").textContent).toBe("4m 9s");
    expect(screen.getByTestId("status").textContent).toBe("daemon");
    expect(screen.queryByText(/syncing/)).toBeNull();
  });

  it("says so while the events stream is not open", () => {
    useHealthStore.setState({ status: "ok", health: { pid: 1, version: "dev", uptimeSeconds: 1 }, error: null });
    useEventsStore.setState({ stream: "retrying" });
    render(<DaemonStatus />);
    expect(screen.getByText("syncing events…")).toBeDefined();
  });

  it("shows unreachable when the daemon is down", () => {
    useHealthStore.setState({ status: "error", health: null, error: "connect failed" });
    render(<DaemonStatus />);
    expect(screen.getByTestId("status").textContent).toBe("daemon unreachable");
  });
});
