import { createContext, useContext } from "react";
import type { UiContextView } from "@/api/command";

/**
 * What every node of one surface's view needs to act: its watch, instance and context. Not
 * the view's version (acts read it from the store): every node consumes this, so it stays
 * the same object from one view to the next.
 */
export interface ViewCtx {
  /** The tab's watch (stores/pluginSurfaces watchKeyOf). */
  watchKey: string;
  /** The daemon's instance key; drafts and collapsed sections hang off it. */
  instance: string;
  plugin: string;
  /** The view's active tab ("" without tabs): drafts are per instance and tab. */
  viewTab: string;
  /** The panel's context: command actions run with it. */
  uiContext: UiContextView;
  /** The plugin is down or not responding: the view is last known, nothing acts. */
  inert: boolean;
}

export const ViewContext = createContext<ViewCtx | null>(null);

/** The surface's ViewCtx; the renderer always provides one. */
export function useViewCtx(): ViewCtx {
  const ctx = useContext(ViewContext);
  if (!ctx) throw new Error("plugin nodes render inside a PluginSurface");
  return ctx;
}

/** The form a field or button sits in (its draft key and pending flag), or null outside one. */
export interface FormCtx {
  draftKey: string;
  formKey: string;
  /** Submitting or busy: every field and button of the form is disabled. */
  locked: boolean;
}

export const FormContext = createContext<FormCtx | null>(null);

export function useFormCtx(): FormCtx | null {
  return useContext(FormContext);
}
