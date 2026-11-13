/**
 * The shot page (docs/notes/plugin-surface-shot-page.md): one plugin surface alone at the
 * window's width, drawn by a plugin tab's own body (PluginSurfaceBody) in the theme as
 * last published, with no app chrome. A request comes from the URL
 * (`?plugin=…&surface=…&scope=…&minVersion=…`) or from window.cfShot(request), which is
 * how the Wails host (gui/shot.go) sends them. Its report marks <html>: data-shot-ready (the
 * content height) or data-shot-error ("<failure>: <reason>"), and data-shot-id; and in the
 * app it goes to the host, which snapshots the window (src/api/shot.ts).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { listPlugins } from "@/api/plugin";
import { reportShotToHost, shotPageReady } from "@/api/shot";
import { getPublishedTheme } from "@/api/ui";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyPluginEvent, usePluginsStore } from "@/stores/plugins";
import { startSurfaceWatch, usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { requestFromSearch, ShotController, type ShotReport, type ShotRequest } from "./controller";
import { Stage } from "./Stage";
import { useShotStage } from "./stageStore";

declare global {
  interface Window {
    /** Starts a shot request, replacing the one in hand (src/shot/controller.ts). */
    cfShot?: (req: ShotRequest) => void;
  }
}

/** <html> with the theme's resolved slots, id and scheme, as lib/theme.ts syncDocumentScheme sets them in the app. */
async function applyTheme(): Promise<void> {
  const theme = await getPublishedTheme();
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.vars)) root.style.setProperty(name, value);
  root.dataset.theme = theme.id;
  root.classList.toggle("dark", theme.scheme === "dark");
  root.style.colorScheme = theme.scheme;
}

async function loadPlugins(): Promise<void> {
  const plugins = await listPlugins();
  usePluginsStore.setState((s) => applyPluginEvent(s, { kind: "snapshot", plugins }));
}

/** The surface's full height: its frame with the scroll area unrolled. */
function measure(): number {
  const surface = document.querySelector<HTMLElement>('[data-testid="shot-stage"] [data-testid="plugin-surface"]');
  if (!surface) return window.innerHeight;
  const scroll = surface.querySelector<HTMLElement>("[data-scroll-root]");
  return surface.getBoundingClientRect().height + (scroll ? scroll.scrollHeight - scroll.clientHeight : 0);
}

const frame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });

function mark(r: ShotReport): void {
  const ds = document.documentElement.dataset;
  ds.shotId = r.id;
  if (r.ok) ds.shotReady = String(r.contentHeight);
  else ds.shotError = `${r.failure}: ${r.reason}`;
}

// Marked first: the host snapshots on its report, and the marks are not drawn.
const report = (r: ShotReport) => {
  mark(r);
  reportShotToHost(r);
};

const controller = new ShotController({
  mount: (watchKey, target) => {
    const stop = startSurfaceWatch(watchKey, target);
    useShotStage.setState({ stage: { watchKey, target } });
    return () => {
      stop();
      useShotStage.setState((s) => (s.stage?.watchKey === watchKey ? { stage: null } : s));
    };
  },
  follow: (watchKey, cb) => {
    cb(usePluginSurfacesStore.getState().watches[watchKey]);
    return usePluginSurfacesStore.subscribe((s, prev) => {
      if (s.watches[watchKey] !== prev.watches[watchKey]) cb(s.watches[watchKey]);
    });
  },
  prepare: async () => {
    await Promise.all([applyTheme(), loadPlugins()]);
  },
  fontsReady: () => document.fonts.ready,
  painted: async () => {
    await frame();
    await frame();
  },
  measure,
  report,
});

window.cfShot = (req) => {
  const ds = document.documentElement.dataset;
  delete ds.shotId;
  delete ds.shotReady;
  delete ds.shotError;
  controller.start(req);
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      <Stage />
    </TooltipProvider>
  </StrictMode>,
);

const fromUrl = requestFromSearch(window.location.search);
if (fromUrl) window.cfShot(fromUrl);
shotPageReady();
