/**
 * The shot page as it reaches the Wails host (gui/shot.go, docs/notes/plugin-surface-shot-host.md).
 * The host hands the page requests through window.cfShot; the page says when it takes them
 * and reports each one here. Outside the app (the mock, a browser) there is no host and
 * these do nothing: the page's <html> marks are the report there.
 */
import { Failed, PageReady, Rendered } from "../../bindings/github.com/alexwaumann/code-foundry/gui/shotservice";

/** A report the host takes: the page's ShotReport (src/shot/controller.ts). */
export type HostShotReport =
  | { id: string; ok: true; contentHeight: number }
  | { id: string; ok: false; failure: string; reason: string };

/** Whether the page runs in the Wails host (lib/title.ts reads it the same way). */
export function inShotHost(): boolean {
  const w = window as { _wails?: { environment?: unknown }; webkit?: { messageHandlers?: Record<string, unknown> } };
  return Boolean(w._wails?.environment) || Boolean(w.webkit?.messageHandlers?.external);
}

function warn(what: string) {
  return (err: unknown) => {
    console.warn(what, err);
  };
}

/** Tells the host the page takes requests (window.cfShot is set). */
export function shotPageReady(): void {
  if (!inShotHost()) return;
  PageReady().catch(warn("shot page ready"));
}

/** Hands the host a request's report: it snapshots a rendered surface, or answers with the reason. */
export function reportShotToHost(r: HostShotReport): void {
  if (!inShotHost()) return;
  const call = r.ok ? Rendered(r.id, { contentHeight: r.contentHeight }) : Failed(r.id, r.failure, r.reason);
  call.catch(warn("shot report"));
}
