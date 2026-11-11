/**
 * The shot page's controller (docs/notes/plugin-surface-shot-page.md): one job per request.
 * It mounts the surface the request names, waits until the view is live at the version
 * asked for, the theme is applied and the fonts are in, then reports the surface's full
 * height; or reports why it could not. A second request replaces the first: the first
 * never reports.
 */
import type { UiContextView } from "@/api/command";
import type { SurfaceEntry } from "@/stores/pluginSurfaces";

/** How long a request waits for its view when it does not say. */
export const SHOT_TIMEOUT_MS = 10_000;

/** What the host asks for: one surface instance, at a version at least `minVersion`. */
export interface ShotRequest {
  /** Echoed in the report: the host matches the two by it. */
  id: string;
  plugin: string;
  surface: string;
  /** An instance the daemon already has (`<plugin>/<surface>/<scope id>`), in place of scope; plugin and surface then default to its own. */
  instance?: string;
  /** The scope id the instance is for: "global" (the default), "thread:<id>", "project:<id>" or "worktree:<path>". */
  scope?: string;
  /** The oldest view version the shot may show (default 1: the first view). */
  minVersion?: number;
  /** How long to wait for it (default SHOT_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * Why a request failed: the plugin is down (crashed, failed, disabled or stopped), the
 * surface could not open, the daemon refused the surface here (not available, not
 * installed, no such instance) or its stream failed, no live view at the version within
 * the time, or the request itself was malformed.
 */
export type ShotFailure = "plugin-down" | "failed" | "unavailable" | "timeout" | "invalid";

export type ShotReport =
  /** contentHeight: the surface's full height in CSS px, its scroll area unrolled (at least the window's height). */
  | { id: string; ok: true; contentHeight: number; version: number }
  | { id: string; ok: false; failure: ShotFailure; reason: string };

/** The watch a request mounts. */
export interface ShotTarget {
  plugin: string;
  surface: string;
  context: UiContextView;
  instance?: string;
}

/** What the controller needs from the page and the daemon. */
export interface ShotDeps {
  /** Starts the surface's watch under `watchKey` and shows it; the returned function stops and hides both. */
  mount: (watchKey: string, target: ShotTarget) => () => void;
  /** Calls `cb` with the watch's entry now and after each change; returns the unsubscribe. */
  follow: (watchKey: string, cb: (e: SurfaceEntry | undefined) => void) => () => void;
  /** Applies the theme as last published and reads the plugins' manifests (the surface's title and icon). */
  prepare: () => Promise<void>;
  /** document.fonts.ready. */
  fontsReady: () => Promise<unknown>;
  /** Resolves once the screen shows what the store holds (two animation frames). */
  painted: () => Promise<void>;
  /** The mounted surface's full height (contentHeight). */
  measure: () => number;
  report: (r: ShotReport) => void;
}

export const EMPTY_CONTEXT: UiContextView = { activeTerminalId: "", activeThreadId: "", activeProjectId: "", activeWorktreePath: "", activeView: "", activeWorkspaceId: "" };

/** The watch a request names, or why it names none. Pure. */
export function targetOf(req: ShotRequest): ShotTarget | string {
  const instance = req.instance ?? "";
  const [iPlugin = "", iSurface = ""] = instance.split("/");
  const plugin = req.plugin || iPlugin;
  const surface = req.surface || iSurface;
  if (!plugin || !surface) return "a request names a plugin and a surface (or an instance)";
  if (instance) return { plugin, surface, context: EMPTY_CONTEXT, instance };
  const scope = req.scope ?? "global";
  const colon = scope.indexOf(":");
  const kind = colon < 0 ? scope : scope.slice(0, colon);
  const value = colon < 0 ? "" : scope.slice(colon + 1);
  if (kind === "global" && colon < 0) return { plugin, surface, context: EMPTY_CONTEXT };
  if (value !== "") {
    if (kind === "thread") return { plugin, surface, context: { ...EMPTY_CONTEXT, activeThreadId: value } };
    if (kind === "project") return { plugin, surface, context: { ...EMPTY_CONTEXT, activeProjectId: value } };
    if (kind === "worktree") return { plugin, surface, context: { ...EMPTY_CONTEXT, activeWorktreePath: value } };
  }
  return `scope ${JSON.stringify(scope)} is not global, thread:<id>, project:<id> or worktree:<path> (a pr scope goes by instance)`;
}

interface Job {
  id: string;
  minVersion: number;
  last: SurfaceEntry | undefined;
  /** Waiting for the theme, fonts and paint: entries no longer decide. */
  settling: boolean;
  done: boolean;
  stops: (() => void)[];
  unmount: (() => void) | null;
}

/** Runs shot requests one at a time on the page. */
export class ShotController {
  private job: Job | null = null;
  private seq = 0;
  private readonly deps: ShotDeps;

  constructor(deps: ShotDeps) {
    this.deps = deps;
  }

  /** Starts a request, replacing the one in hand (which then never reports). */
  start(req: ShotRequest): void {
    this.replace();
    const job: Job = { id: req.id, minVersion: Math.max(1, req.minVersion ?? 1), last: undefined, settling: false, done: false, stops: [], unmount: null };
    this.job = job;
    const target = targetOf(req);
    if (typeof target === "string") {
      this.fail(job, "invalid", target);
      return;
    }
    const timeoutMs = req.timeoutMs ?? SHOT_TIMEOUT_MS;
    // Each request its own watch key: the old one's entry goes with its unmount.
    const watchKey = `shot\u0000${String(++this.seq)}\u0000${req.id}`;
    job.unmount = this.deps.mount(watchKey, target);
    const timer = setTimeout(() => {
      this.fail(job, "timeout", timeoutReason(job, timeoutMs));
    }, timeoutMs);
    job.stops.push(() => {
      clearTimeout(timer);
    });
    const prepared = this.deps.prepare().catch((err: unknown) => {
      // The colours and names stay the last read; the shot still reports.
      console.warn("shot prepare", err);
    });
    // follow calls back at once: job.stops must already hold the timer.
    job.stops.push(
      this.deps.follow(watchKey, (e) => {
        this.onEntry(job, e, prepared);
      }),
    );
  }

  /** Stops the request in hand and unmounts its surface, without a report. */
  stop(): void {
    this.replace();
  }

  private replace(): void {
    const old = this.job;
    if (!old) return;
    this.job = null;
    old.done = true;
    for (const s of old.stops.splice(0)) s();
    old.unmount?.();
  }

  private onEntry(job: Job, e: SurfaceEntry | undefined, prepared: Promise<void>): void {
    if (job.done || job.settling) return;
    job.last = e;
    if (!e) return;
    if (e.error !== null) {
      this.fail(job, "unavailable", e.error);
      return;
    }
    if (e.phase === "failed") {
      this.fail(job, "failed", e.message || "the surface could not open");
      return;
    }
    // A plugin starting (a dev plugin rebuilt and restarted) comes back: wait for it.
    if (e.phase === "plugin-down" && e.pluginState !== "starting") {
      this.fail(job, "plugin-down", e.message || `the plugin is ${e.pluginState}`);
      return;
    }
    if (e.phase !== "live" || e.version < job.minVersion) return;
    job.settling = true;
    void (async () => {
      await prepared;
      await this.deps.fontsReady();
      await this.deps.painted();
      if (job.done) return;
      this.finish(job, { id: job.id, ok: true, contentHeight: Math.ceil(this.deps.measure()), version: job.last?.version ?? 0 });
    })();
  }

  private fail(job: Job, failure: ShotFailure, reason: string): void {
    if (job.done) return;
    this.finish(job, { id: job.id, ok: false, failure, reason });
  }

  /** Reports and stops following; the surface stays on screen until the next request. */
  private finish(job: Job, r: ShotReport): void {
    job.done = true;
    for (const s of job.stops.splice(0)) s();
    this.deps.report(r);
  }
}

function timeoutReason(job: Job, ms: number): string {
  const e = job.last;
  const want = `no live view at version ${String(job.minVersion)} or later within ${String(ms)} ms`;
  if (!e) return `${want} (the stream sent nothing)`;
  const at = `phase ${e.phase}, version ${String(e.version)}`;
  return `${want} (${at}${e.message ? `: ${e.message}` : ""})`;
}

/**
 * The request a page URL names (`?plugin=…&surface=…&scope=…&instance=…&minVersion=…&timeoutMs=…&id=…`),
 * or null when it names no surface. Its id defaults to "url".
 */
export function requestFromSearch(search: string): ShotRequest | null {
  const q = new URLSearchParams(search);
  const plugin = q.get("plugin") ?? "";
  const surface = q.get("surface") ?? "";
  const instance = q.get("instance") ?? "";
  if (!instance && !plugin && !surface) return null;
  const num = (name: string) => {
    const v = Number(q.get(name) ?? "");
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const minVersion = num("minVersion");
  const timeoutMs = num("timeoutMs");
  const scope = q.get("scope");
  return {
    id: q.get("id") ?? "url",
    plugin,
    surface,
    ...(instance ? { instance } : {}),
    ...(scope ? { scope } : {}),
    ...(minVersion !== undefined ? { minVersion } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}
