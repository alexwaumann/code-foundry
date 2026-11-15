/**
 * How code and diffs render (components/code): unified or split diffs, wrapped or
 * scrolled long lines, and which mode the File tab opens each preview kind in (markdown
 * Rendered or Source, an SVG Image or Source; components/files/previews). One choice for
 * the whole app, not per tab. Persisted (localStorage "code-foundry.codeView"); not
 * settings: they are not in the file.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { bool, oneOf, persistedRecord, recordOf } from "./persisted";

export type DiffStyle = "unified" | "split";

interface CodeViewState {
  diffStyle: DiffStyle;
  wrap: boolean;
  /**
   * The last mode picked, by preview kind id ("markdown" → "source"). A kind with nothing
   * here, or a mode its switch no longer has, opens in its first mode (previews/registry.ts
   * pickMode), so this store knows no kind and no mode by name.
   */
  preview: Readonly<Record<string, string>>;
}

export const useCodeViewStore = create<CodeViewState>()(
  persist((): CodeViewState => ({ diffStyle: "unified", wrap: false, preview: {} }), {
    name: "code-foundry.codeView",
    version: 1,
    // Only known fields of the right type (stores/persisted.ts). `preview` keeps its strings: whether one is a mode is the kind's call.
    merge: (persisted, current) => {
      const p = persistedRecord(persisted);
      return {
        ...current,
        diffStyle: oneOf<DiffStyle>(p.diffStyle, ["unified", "split"], current.diffStyle),
        wrap: bool(p.wrap, current.wrap),
        preview: { ...current.preview, ...recordOf(p.preview, (v) => (typeof v === "string" ? v : undefined)) },
      };
    },
  }),
);

export function setDiffStyle(diffStyle: DiffStyle): void {
  useCodeViewStore.setState({ diffStyle });
}

export function setWrap(wrap: boolean): void {
  useCodeViewStore.setState({ wrap });
}

/** Remembers `mode` as the one files of preview kind `kind` open in. */
export function setPreviewMode(kind: string, mode: string): void {
  useCodeViewStore.setState((s) => ({ preview: { ...s.preview, [kind]: mode } }));
}
