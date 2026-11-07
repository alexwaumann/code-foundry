import { createElement } from "react";
import { Globe } from "lucide-react";
import { BrowserSurface } from "@/components/browser/BrowserSurface";
import { browserEnabled, closeBrowserSurface } from "@/stores/browser";
import { useSettingsStore } from "@/stores/settings";
import { BROWSER_KIND, BROWSER_TITLE, browserTab } from "./browserTarget";
import type { SurfaceSpec } from "./types";

/**
 * Browser: real sites in a headless system Chrome, drawn from a screencast
 * (docs/notes/chrome-surface.md). Experimental: listed only while experimental.chrome_surface
 * is on. One tab per panel, whose page the panel's key names.
 */
export const browserSurface: SurfaceSpec = {
  kind: BROWSER_KIND,
  title: BROWSER_TITLE,
  icon: Globe,
  hotkey: "c",
  available: () => (browserEnabled() ? "enabled" : "hidden"),
  watches: [useSettingsStore],
  beforeClose: (panelKey) => {
    closeBrowserSurface(panelKey);
    return true;
  },
  render: () => createElement(BrowserSurface),
  openDefault: () => (browserEnabled() ? browserTab() : null),
};
