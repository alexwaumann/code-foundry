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
