import type { UpdateStatusView } from "@/api/update";
import type { CutOff } from "./thread";

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

const TIP = /^(v?\d+\.\d+\.\d+)-tip\.(\d+)$/;

/**
 * A version as the GUI shows it. Tip builds are tagged `vX.Y.Z-tip.N` (strict semver: a
 * prerelease of the next stable, N = tip releases since the last stable) and read
 * `vX.Y.Z (tip N)`; stable tags and anything else ("dev") are shown as they are. The
 * CLI, tags and release names keep the raw tag.
 */
export function displayVersion(v: string): string {
  const m = TIP.exec(v);
  return m ? `${m[1] ?? ""} (tip ${m[2] ?? ""})` : v;
}

/** The window and the daemon run different versions (see versionMismatch). */
export interface Mismatch {
  /** The window's version. */
  app: string;
  /** The running daemon's version. */
  daemon: string;
  /** The newer of the two: the version that is partly applied. */
  version: string;
}

/**
 * The window and the daemon run different versions, so a restart is still needed:
 *
 *  - idle, GUI newer than the daemon (the window was relaunched, the daemon was not)
 *  - idle, daemon newer than the GUI (the daemon restarted on its own, e.g. from the CLI)
 *  - installed / restartRequired with the GUI already on the installed version
 *
 * `guiVersion` is the window shell's own version (null outside Wails, e.g. browser dev).
 * Unparseable versions ("dev") never count.
 */
export function versionMismatch(status: UpdateStatusView, guiVersion: string | null): Mismatch | null {
  if (guiVersion === null) return null;
  const daemon = status.currentVersion;
  switch (status.state) {
    case "idle": {
      const c = compareVersions(guiVersion, daemon);
      if (c === null || c === 0) return null;
      return { app: guiVersion, daemon, version: c > 0 ? guiVersion : daemon };
    }
    case "installed":
    case "restartRequired":
      if (compareVersions(guiVersion, status.targetVersion) !== 0) return null;
      return { app: guiVersion, daemon, version: status.targetVersion };
    default:
      return null;
  }
}

export type UpdateBadgeKind = "available" | "downloading" | "downloaded" | "failed" | "installed";

export interface UpdateBadge {
  kind: UpdateBadgeKind;
  label: string;
  /** The muted call to action on the chip's right; "" for none. */
  cta: string;
}

/**
 * The sidebar status row's update chip. One restart (app.restart) installs a download and
 * applies it to both the daemon and the window, so downloaded reads "vX downloaded ·
 * Restart to apply", and installed, restart-required and partly applied (the install on
 * disk is newer than what runs) "vX installed · Restart to apply".
 */
export function updateBadge(status: UpdateStatusView | null, guiVersion: string | null): UpdateBadge | null {
  if (!status) return null;
  const target = displayVersion(status.targetVersion);
  switch (status.state) {
    case "available":
      return { kind: "available", label: `${target} available`, cta: "Download" };
    case "downloading":
      return { kind: "downloading", label: `Downloading ${target}…`, cta: "" };
    case "downloaded":
      return { kind: "downloaded", label: `${target} downloaded`, cta: "Restart to apply" };
    case "failed":
      return { kind: "failed", label: "Update failed", cta: "Details" };
    case "installed":
    case "restartRequired":
      return { kind: "installed", label: `${target} installed`, cta: "Restart to apply" };
    case "idle": {
      const m = versionMismatch(status, guiVersion);
      return m ? { kind: "installed", label: `${displayVersion(m.version)} installed`, cta: "Restart to apply" } : null;
    }
  }
}

/**
 * Threads a restart would cut off: busy = working, waiting on the user or running background work (restartCutsOff,
 * the daemon's command.ActiveSession). Any other thread loses nothing: a message starts it
 * again.
 */
export interface ThreadActivity {
  busy: number;
}

export type UpdateVariant =
  | "disabled"
  | "restarting"
  | "upToDate"
  | "available"
  | "downloading"
  | "failed"
  | "readyIdle"
  | "readyBusy"
  | "partlyApplied";

/** What the update dialog shows; the component adds icons, buttons and the meta line. */
export interface UpdateView {
  variant: UpdateVariant;
  title: string;
  body: string;
  /** The primary button's label; null for none (downloading, restarting, disabled). */
  primary: string | null;
  /** The version offered, downloading, downloaded, installed or partly applied (current when up to date). */
  version: string;
  /** The muted link under the primary button; it closes the dialog. null for none. */
  later: string | null;
  /** A × in the corner: only where there is no `later` link to close with. */
  close: boolean;
  /** List the busy threads (working or waiting on the user: a restart cuts them off mid-turn). */
  showBusy: boolean;
  /** Set for partlyApplied. */
  mismatch: Mismatch | null;
}

function threads(n: number): string {
  return `${String(n)} thread${n === 1 ? "" : "s"}`;
}

/** "2 threads would be cut off", "1 thread would be cut off". */
export function busyHeading(n: number): string {
  return `${threads(n)} would be cut off`;
}

/**
 * What a restart cuts off in one thread, for its row in the busy list: "working", "waiting
 * on you", its background work ("2 background agents and 1 shell", "1 background shell"),
 * "reporting finished work".
 */
export function cutOffLabel(kind: CutOff, agents: number, shells: number): string {
  switch (kind) {
    case "working":
      return "working";
    case "waiting":
      return "waiting on you";
    case "reporting":
      return "reporting finished work";
    case "background": {
      const count = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? "" : "s"}`;
      if (agents > 0 && shells > 0) return `${count(agents, "background agent")} and ${count(shells, "shell")}`;
      return agents > 0 ? count(agents, "background agent") : count(shells, "background shell");
    }
  }
}

/**
 * Restart Now already ran. `install` is the downloaded version app.restart installs
 * before restarting ("" when nothing was downloaded: a plain restart).
 */
export interface Restarting {
  install: string;
}

function cutOff(busy: number): string {
  return busy === 1 ? "Restarting now cuts this thread off." : "Restarting now cuts these threads off.";
}

function laterFor(t: ThreadActivity): string {
  return t.busy > 0 ? "Wait, I’ll restart later" : "Later";
}

/**
 * On the stable channel, the latest stable release is older than the running build: a
 * switch from tip, which never offers a downgrade. The next stable release above this
 * build is offered as a normal update.
 */
export function olderStable(status: UpdateStatusView): boolean {
  return status.channel === "stable" && compareVersions(status.latestVersion, status.currentVersion) === -1;
}

function sentence(s: string): string {
  if (!s) return "";
  const t = `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** What a ready dialog says with threads a restart would cut off. */
function readyBusyRest(busy: number, install: boolean): string {
  const anyway = install ? "install and restart anyway" : "restart anyway";
  return busy === 1
    ? `Let it finish first, or ${anyway}: it keeps its history, and a message continues it.`
    : `Let them finish first, or ${anyway}: they keep their history, and a message continues each.`;
}

/**
 * Picks the update dialog's variant and copy from the daemon's updater status, the
 * window's own version, the busy thread count, and whether Restart Now already ran.
 */
export function updateView(status: UpdateStatusView, guiVersion: string | null, t: ThreadActivity, restarting: Restarting | null = null): UpdateView {
  // Copy shows versions through displayVersion; `version` and `mismatch` keep the tags.
  const target = displayVersion(status.targetVersion);
  const current = displayVersion(status.currentVersion);
  const base = { version: status.targetVersion, primary: null, later: "Later", close: false, showBusy: false, mismatch: null };
  if (restarting) {
    if (restarting.install) {
      return {
        ...base,
        variant: "restarting",
        version: restarting.install,
        title: "Installing and restarting…",
        body: `Code Foundry will reopen in a moment on ${displayVersion(restarting.install)}.`,
        later: null,
      };
    }
    return { ...base, variant: "restarting", title: "Restarting…", body: "Code Foundry will reopen in a moment.", later: null };
  }
  if (!status.enabled) {
    return { ...base, variant: "disabled", version: status.currentVersion, title: "Updates are off for this build", body: sentence(status.disabledReason), later: null, close: true };
  }
  const m = versionMismatch(status, guiVersion);
  if (m) {
    const app = displayVersion(m.app);
    const daemon = displayVersion(m.daemon);
    const where = compareVersions(m.app, m.daemon) === 1 ? `The app is on ${app} but the daemon is still on ${daemon}` : `The daemon is on ${daemon} but the app is still on ${app}`;
    return {
      ...base,
      variant: "partlyApplied",
      version: m.version,
      title: `Code Foundry ${displayVersion(m.version)} is partly applied`,
      body: `${where}; some things won’t work until you restart.${t.busy > 0 ? ` ${cutOff(t.busy)}` : ""}`,
      primary: "Restart Now",
      later: laterFor(t),
      showBusy: t.busy > 0,
      mismatch: m,
    };
  }
  switch (status.state) {
    case "idle":
      return {
        ...base,
        variant: "upToDate",
        version: status.currentVersion,
        title: status.checking ? "Checking for updates…" : "You’re up to date",
        body: olderStable(status) ? sentence(`stable ${displayVersion(status.latestVersion)} is older than this build; the next stable release will move you`) : `Code Foundry ${current} is the latest version.`,
        primary: "Check Again",
        later: null,
        close: true,
      };
    case "available":
      return {
        ...base,
        variant: "available",
        title: `Code Foundry ${target} is available`,
        body: `You’re on ${current}. Downloading happens in the background and changes nothing until you restart.`,
        primary: `Download ${target}`,
      };
    case "downloading":
      return {
        ...base,
        variant: "downloading",
        title: `Downloading ${target}…`,
        body: "You can close this and keep working. Nothing changes on disk until you install and restart.",
        later: "Hide",
      };
    case "failed":
      return { ...base, variant: "failed", title: `Couldn’t update to ${target}`, body: `Nothing changed. You’re still on ${current}.`, primary: "Try Again", later: "Not now" };
    case "downloaded":
    case "installed":
    case "restartRequired": {
      // Downloaded: app.restart installs first. Installed / restart required: the install
      // on disk is already newer (the installer ran by hand, or a restart did not follow).
      const install = status.state === "downloaded";
      const title = `Code Foundry ${target} is ready`;
      const primary = install ? "Install and Restart Now" : "Restart Now";
      if (t.busy > 0) {
        return { ...base, variant: "readyBusy", title, body: `${cutOff(t.busy)} ${readyBusyRest(t.busy, install)}`, primary, later: laterFor(t), showBusy: true };
      }
      const body = install
        ? "Install and restart to finish updating. The app and the daemon update together, so nothing ends up out of sync. No thread is working or waiting on you, so nothing will be interrupted."
        : "Restart to finish updating. No thread is working or waiting on you, so nothing will be interrupted.";
      return { ...base, variant: "readyIdle", title, body, primary };
    }
  }
}

/** The failure callout's first line: "Installer exited with status 1" when the reason says so. */
export function failureHeadline(reason: string): string {
  const m = /exit status (\d+)/.exec(reason);
  return m?.[1] ? `Installer exited with status ${m[1]}` : "Installer failed";
}
