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

export type UpdateBadgeKind = "available" | "downloading" | "failed" | "installed";

export interface UpdateBadge {
  kind: UpdateBadgeKind;
  label: string;
  /** The muted call to action on the chip's right; "" for none. */
  cta: string;
}

/**
 * The sidebar status row's update chip. One restart (app.restart) applies an installed
 * update to both the daemon and the window, so installed, restart-required and partly
 * applied all read "vX installed · Restart to apply".
 */
export function updateBadge(status: UpdateStatusView | null, guiVersion: string | null): UpdateBadge | null {
  if (!status) return null;
  const target = displayVersion(status.targetVersion);
  switch (status.state) {
    case "available":
      return { kind: "available", label: `${target} available`, cta: "Install" };
    case "downloading":
      return { kind: "downloading", label: `Installing ${target}…`, cta: "" };
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
 * Threads a restart would cut off: busy = working or waiting on the user (restartCutsOff,
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
  | "installing"
  | "failed"
  | "readyIdle"
  | "readyBusy"
  | "partlyApplied";

/** What the update dialog shows; the component adds icons, buttons and the meta line. */
export interface UpdateView {
  variant: UpdateVariant;
  title: string;
  body: string;
  /** The version offered, installing, installed or partly applied (current when up to date). */
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

/** "2 threads are working or waiting on you", "1 thread is working or waiting on you". */
export function busyHeading(n: number): string {
  return `${threads(n)} ${n === 1 ? "is" : "are"} working or waiting on you`;
}

function cutOff(busy: number): string {
  return busy === 1 ? "Restarting now cuts this thread off mid-turn." : "Restarting now cuts these threads off mid-turn.";
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

/**
 * Picks the update dialog's variant and copy from the daemon's updater status, the
 * window's own version, the busy thread count, and whether Restart Now already ran.
 */
export function updateView(status: UpdateStatusView, guiVersion: string | null, t: ThreadActivity, restarting = false): UpdateView {
  // Copy shows versions through displayVersion; `version` and `mismatch` keep the tags.
  const target = displayVersion(status.targetVersion);
  const current = displayVersion(status.currentVersion);
  const base = { version: status.targetVersion, later: "Later", close: false, showBusy: false, mismatch: null };
  if (restarting) {
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
        later: null,
        close: true,
      };
    case "available":
      return {
        ...base,
        variant: "available",
        title: `Code Foundry ${target} is available`,
        body: `You’re on ${current}. Installing happens in the background; you’ll be asked to restart when it’s done.`,
      };
    case "downloading":
      return { ...base, variant: "installing", title: `Installing ${target}…`, body: "You can close this and keep working.", later: "Hide" };
    case "failed":
      return { ...base, variant: "failed", title: `Couldn’t install ${target}`, body: `Nothing changed. You’re still on ${current}.`, later: "Not now" };
    case "installed":
    case "restartRequired": {
      const title = `Code Foundry ${target} is ready`;
      if (t.busy > 0) {
        const rest =
          t.busy === 1
            ? "Let it finish first, or restart anyway: it keeps its history, and a message continues it."
            : "Let them finish first, or restart anyway: they keep their history, and a message continues each.";
        return { ...base, variant: "readyBusy", title, body: `${cutOff(t.busy)} ${rest}`, later: laterFor(t), showBusy: true };
      }
      return { ...base, variant: "readyIdle", title, body: "Restart to finish updating. No thread is working or waiting on you, so nothing will be interrupted." };
    }
  }
}

/** The failure callout's first line: "Installer exited with status 1" when the reason says so. */
export function failureHeadline(reason: string): string {
  const m = /exit status (\d+)/.exec(reason);
  return m?.[1] ? `Installer exited with status ${m[1]}` : "Installer failed";
}
