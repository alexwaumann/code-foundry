/**
 * The dictation overlay's page (docs/notes/dictate-anywhere-overlay.md): a separate Vite
 * entry the host's panel loads, with no React and none of the app's stores or CSS.
 */
import { followOverlaySession, onOverlayBegin, overlayPageDone, overlayPageReady, overlayThemeVars } from "@/api/overlay";
import { scopeColours } from "./colours";
import { OverlayController } from "./controller";
import { drawScope } from "./scope";

const canvas = document.getElementById("scope");
if (!(canvas instanceof HTMLCanvasElement)) throw new Error("missing #scope");
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("no 2d context");

/** Fits the backing store to the window and the screen's scale: each show may be on another screen. */
function fit(el: HTMLCanvasElement): number {
  const scale = window.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * scale);
  const h = Math.round(window.innerHeight * scale);
  if (el.width !== w) el.width = w;
  if (el.height !== h) el.height = h;
  return scale;
}

const controller = new OverlayController({
  requestFrame: (cb) => window.requestAnimationFrame(cb),
  follow: followOverlaySession,
  colours: async () => scopeColours(await overlayThemeVars()),
  paint: (scope, colours) => {
    const scale = fit(canvas);
    drawScope(ctx, scope, colours, scale, window.innerWidth, window.innerHeight);
  },
  clear: () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  },
  done: (sessionId) => {
    overlayPageDone(sessionId).catch((err: unknown) => {
      // No host (a browser, e2e), or it quit.
      console.warn("overlay done", err);
    });
  },
});

onOverlayBegin((id) => {
  controller.begin(id);
});
// Listening first, then asking, so a session is heard one way or the other.
overlayPageReady().then(
  (id) => {
    if (id !== "") controller.begin(id);
  },
  (err: unknown) => {
    console.warn("overlay ready", err);
  },
);

if (import.meta.env.DEV) {
  // No host in a browser: e2e names the session itself.
  const id = new URLSearchParams(window.location.search).get("session");
  if (id) controller.begin(id);
}
