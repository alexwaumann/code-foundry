/**
 * The first-load import (docs/notes/shell-model.md, "First load for an existing user";
 * docs/notes/shell-18-legacy-import.md): before the window shell first draws, when the daemon's
 * layout says the import has not run, this window sends the classic window's stored side panels
 * and bottom panels (the raw localStorage strings: the daemon runs their migrations) to
 * LayoutService.ImportLegacy, once, and draws from the layout it answers. Both keys stay in
 * localStorage (a downgraded window still finds them). A second window, or a retry after a lost
 * answer, gets "already imported" and the layout as it is.
 *
 * A failure does not leave the window blank: the shell shows what happened, with Try again and
 * "Open without them" (the next launch tries again, since the mark is still unset).
 * See docs/notes/shell-20-cutover.md.
 */
import { create } from "zustand";
import { importLegacy } from "@/api/layout";
import { errorMessage } from "@/api/stream";
import { applyImportedLayout, useLayoutStore } from "@/stores/layout";

/**
 * The classic window's persisted side panels and bottom panels, read as raw strings: their stores
 * are gone (docs/notes/shell-21-remove-classic.md), the keys stay for this import.
 */
export const LEGACY_PANEL_KEY = "code-foundry.panel";
export const LEGACY_BOTTOM_KEY = "code-foundry.bottom";

export type LegacyImportPhase = "idle" | "running" | "done" | "failed" | "skipped";

interface LegacyImportState {
  phase: LegacyImportPhase;
  /** Why the last call failed; "" otherwise. */
  error: string;
}

export const useLegacyImportStore = create<LegacyImportState>()(() => ({ phase: "idle", error: "" }));

/** The raw stored values, "" for an absent key or blocked storage. */
export function readLegacyStores(storage: Pick<Storage, "getItem"> | null = safeStorage()): { panelJson: string; bottomJson: string } {
  const read = (key: string): string => {
    try {
      return storage?.getItem(key) ?? "";
    } catch {
      return "";
    }
  };
  return { panelJson: read(LEGACY_PANEL_KEY), bottomJson: read(LEGACY_BOTTOM_KEY) };
}

function safeStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * Runs the import if this window has not and the daemon's layout says it is due. One call at a
 * time; resolves when it settled. `run` sends it (tests).
 */
export async function runLegacyImport(run: typeof importLegacy = importLegacy): Promise<void> {
  const st = useLegacyImportStore.getState();
  if (st.phase === "running") return;
  const layout = useLayoutStore.getState();
  if (!layout.loaded) return;
  if (layout.legacyImported) {
    useLegacyImportStore.setState({ phase: "done", error: "" });
    return;
  }
  useLegacyImportStore.setState({ phase: "running", error: "" });
  const { panelJson, bottomJson } = readLegacyStores();
  try {
    const res = await run(panelJson, bottomJson);
    applyImportedLayout(res.layout);
    useLegacyImportStore.setState({ phase: "done", error: "" });
  } catch (err) {
    useLegacyImportStore.setState({ phase: "failed", error: errorMessage(err) });
  }
}

/** "Open without them": the shell draws from the layout as it is; the next launch tries again. */
export function skipLegacyImport(): void {
  useLegacyImportStore.setState({ phase: "skipped" });
}

/** Whether the shell may draw: the layout arrived and the import ran (here, before, or was skipped). */
export function importSettled(loaded: boolean, imported: boolean, phase: LegacyImportPhase): boolean {
  return loaded && (imported || phase === "done" || phase === "skipped");
}

/** Back to a new window's state (tests). */
export function resetLegacyImport(): void {
  useLegacyImportStore.setState({ phase: "idle", error: "" }, true);
}
