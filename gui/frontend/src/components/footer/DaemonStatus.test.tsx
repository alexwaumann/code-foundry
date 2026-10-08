import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useHealthStore } from "@/stores/health";
import { useIntentsStore } from "@/stores/intents";
import { useReposStore } from "@/stores/repos";
import { useTerminalsStore } from "@/stores/terminals";
import { DaemonStatus } from "./DaemonStatus";

afterEach(cleanup);

describe("DaemonStatus", () => {
  it("renders pid, version, and uptime from the health store", () => {
    useHealthStore.setState({ status: "ok", health: { pid: 4242, version: "1.2.3", uptimeSeconds: 249 }, error: null });
    for (const s of [useTerminalsStore, useReposStore, useIntentsStore]) s.setState({ stream: "open" });
    render(<DaemonStatus />);
    expect(screen.getByTestId("pid").textContent).toBe("4242");
    expect(screen.getByTestId("version").textContent).toBe("1.2.3");
    expect(screen.getByTestId("uptime").textContent).toBe("4m 9s");
    expect(screen.getByTestId("status").textContent).toBe("daemon");
    expect(screen.queryByText(/syncing/)).toBeNull();
  });

  it("names streams that are not open", () => {
    useHealthStore.setState({ status: "ok", health: { pid: 1, version: "dev", uptimeSeconds: 1 }, error: null });
    useTerminalsStore.setState({ stream: "retrying" });
    useReposStore.setState({ stream: "open" });
    useIntentsStore.setState({ stream: "open" });
    render(<DaemonStatus />);
    expect(screen.getByText("syncing terminals…")).toBeDefined();
  });

  it("shows unreachable when the daemon is down", () => {
    useHealthStore.setState({ status: "error", health: null, error: "connect failed" });
    render(<DaemonStatus />);
    expect(screen.getByTestId("status").textContent).toBe("daemon unreachable");
  });
});
