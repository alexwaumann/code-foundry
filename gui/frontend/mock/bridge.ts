/**
 * GET /cf/bridge.js: the daemon's page bridge script (internal/bridge/bridge.js), read
 * from the repository like the theme files (mock/theme.ts), so a mock page that loads it
 * runs the real script against the GUI's host (docs/notes/bridge-1-daemon.md).
 */
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("../../../internal/bridge/bridge.js", import.meta.url), "utf8");

/** GET /cf/bridge.js; undefined for any other path. */
export function bridgeRoute(pathname: string): { type: string; body: string } | undefined {
  return pathname === "/cf/bridge.js" ? { type: "text/javascript; charset=utf-8", body: script } : undefined;
}

/** One `thread.wait` the mock held: its args, and whether its caller aborted it. */
export interface MockWait {
  args: Record<string, string>;
  aborted: boolean;
}

const waits: MockWait[] = [];

/**
 * CommandService.Invoke("thread.wait"): held until the caller aborts the call, as the
 * daemon's wait ends when its request is cancelled (docs/notes/bridge-fix-frames.md), so
 * e2e sees a page's cf:cancel reach the daemon. GET /__mock/waits lists them.
 */
export function holdWait(args: Record<string, string>, signal: AbortSignal): Promise<never> {
  const w: MockWait = { args, aborted: false };
  waits.push(w);
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      w.aborted = true;
      reject(new Error("the wait was cancelled"));
    });
  });
}

export function mockWaits(): readonly MockWait[] {
  return waits;
}

export function resetWaits(): void {
  waits.length = 0;
}
