import type { UpdateStatusView } from "@/api/update";

interface Semver {
  core: [number, number, number];
  pre: string[];
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(v: string): Semver | null {
  const m = SEMVER.exec(v);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver precedence of a vs b (-1, 0, 1), or null when either is not a version ("dev"). */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre.length === 0 || y.pre.length === 0) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i] ?? "";
    const q = y.pre[i] ?? "";
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return Math.sign(x.pre.length - y.pre.length);
}

export type UpdateBadgeKind = "available" | "downloading" | "failed" | "relaunch" | "restart";

export interface UpdateBadge {
  kind: UpdateBadgeKind;
  label: string;
}

/**
 * The sidebar status row's update indicator. `guiVersion` is the window shell's own version (null
 * outside Wails). After an install the GUI needs a relaunch and the daemon a restart;
 * which one is still pending depends on what each is running:
 *
 *  - GUI older than the installed version            -> "relaunch to apply"
 *  - GUI current, daemon still on the old version    -> "daemon restart pending"
 *  - daemon restarted first (idle, newer than GUI)   -> "relaunch to apply"
 */
export function updateBadge(status: UpdateStatusView | null, guiVersion: string | null): UpdateBadge | null {
  if (!status) return null;
  const target = status.targetVersion;
  const guiStale = (v: string) => guiVersion !== null && compareVersions(guiVersion, v) === -1;
  switch (status.state) {
    case "available":
      return { kind: "available", label: `update ready ${target}` };
    case "downloading":
      return { kind: "downloading", label: `updating to ${target}…` };
    case "failed":
      return { kind: "failed", label: "update failed" };
    case "installed":
      // Without knowing the GUI's version (browser dev), assume it still needs the relaunch.
      if (guiVersion === null || guiStale(target)) return { kind: "relaunch", label: "relaunch to apply" };
      return { kind: "restart", label: "daemon restart pending" };
    case "restartRequired":
      if (guiStale(target)) return { kind: "relaunch", label: "relaunch to apply" };
      return { kind: "restart", label: "daemon restart pending" };
    case "idle":
      if (guiStale(status.currentVersion)) return { kind: "relaunch", label: "relaunch to apply" };
      return null;
  }
}
