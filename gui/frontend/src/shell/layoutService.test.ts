import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { layoutOf, pane, space, tab } from "@/test/shellLayout";

/** What each command answers, by name: a result, null (the user declined), or an error. */
const answers = new Map<string, unknown>();
const invoked: string[] = [];
const relaunched = vi.fn(() => Promise.resolve(true));

vi.mock("@/stores/commands", () => ({
  invokeConfirmed: (name: string) => {
    invoked.push(name);
    const a = answers.get(name);
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a ?? null);
  },
}));
vi.mock("@/api/app", async (orig) => ({ ...(await orig<typeof import("@/api/app")>()), relaunchApp: () => relaunched() }));

const { probeLayoutService, resetLayoutService, restartOldDaemon, useLayoutServiceStore } = await import("./layoutService");
const { resetLayout, useLayoutStore } = await import("@/stores/layout");

beforeEach(() => {
  answers.clear();
  invoked.length = 0;
  relaunched.mockClear();
  resetLayout();
  resetLayoutService();
});

afterEach(() => {
  resetLayout();
});

describe("asking a waiting daemon for the layout", () => {
  it("a daemon without the layout service (Unimplemented, its mux's 404): it predates the window", async () => {
    const got = await probeLayoutService(() => Promise.reject(new ConnectError("HTTP 404", Code.Unimplemented)));
    expect(got).toBe("missing");
    expect(useLayoutServiceStore.getState().missing).toBe(true);
    expect(useLayoutStore.getState().loaded).toBe(false);
  });

  it("any other failure (down, timed out, aborted) says nothing about the service", async () => {
    for (const err of [new ConnectError("down", Code.Unavailable), new TypeError("Load failed"), new DOMException("aborted", "AbortError")]) {
      expect(await probeLayoutService(() => Promise.reject(err))).toBe("unknown");
      expect(useLayoutServiceStore.getState().missing).toBe(false);
    }
  });

  it("a daemon that has it: its answer is the layout, applied as a snapshot, and a missing mark goes", async () => {
    useLayoutServiceStore.setState({ missing: true });
    const l = { ...layoutOf([space(pane("p-1", [tab("t-1", "prs")]), "p-1")], 7), legacyImported: true };
    expect(await probeLayoutService(() => Promise.resolve(l))).toBe("present");
    expect(useLayoutStore.getState()).toMatchObject({ loaded: true, rev: 7 });
    expect(useLayoutServiceStore.getState().missing).toBe(false);
  });
});

describe("Restart Now on the notice", () => {
  it("runs app.restart through its confirmation and then shows that it restarts", async () => {
    answers.set("app.restart", { message: "restarting Code Foundry" });
    await restartOldDaemon();
    expect(invoked).toEqual(["app.restart"]);
    expect(useLayoutServiceStore.getState()).toMatchObject({ restarting: true, error: "" });
    expect(relaunched).not.toHaveBeenCalled();
  });

  it("declined: nothing changes", async () => {
    await restartOldDaemon();
    expect(invoked).toEqual(["app.restart"]);
    expect(useLayoutServiceStore.getState().restarting).toBe(false);
  });

  it("a daemon older than app.restart: daemon.restart, then the host relaunches the app", async () => {
    answers.set("app.restart", new ConnectError("unknown command", Code.NotFound));
    answers.set("daemon.restart", { message: "restarting the daemon" });
    await restartOldDaemon();
    expect(invoked).toEqual(["app.restart", "daemon.restart"]);
    expect(relaunched).toHaveBeenCalledTimes(1);
    expect(useLayoutServiceStore.getState().restarting).toBe(true);
  });

  it("a failure is shown, and the button stays", async () => {
    answers.set("app.restart", new ConnectError("this daemon cannot restart itself", Code.Unknown));
    await restartOldDaemon();
    expect(useLayoutServiceStore.getState()).toMatchObject({ restarting: false, error: expect.stringContaining("cannot restart itself") as unknown });
  });
});
