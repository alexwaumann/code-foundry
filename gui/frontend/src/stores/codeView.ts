/**
 * How code and diffs render (components/code): unified or split diffs, wrapped or
 * scrolled long lines, and whether the File tab shows a markdown or HTML file rendered or
 * as source. One choice for the whole app, not per tab. Persisted (localStorage
 * "code-foundry.codeView"); not settings: they are not in the file.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { bool, oneOf, persistedRecord } from "./persisted";

export type DiffStyle = "unified" | "split";

/** The kinds of file the File tab can render as well as show as source. */
export type PreviewKind = "markdown" | "html";
export type PreviewMode = "rendered" | "source";

interface CodeViewState {
  diffStyle: DiffStyle;
  wrap: boolean;
  /** Rendered or source, by kind. A store saved before it existed gets the default (persist merges). */
  preview: Readonly<Record<PreviewKind, PreviewMode>>;
}

const MODES: readonly PreviewMode[] = ["rendered", "source"];

export const useCodeViewStore = create<CodeViewState>()(
  persist((): CodeViewState => ({ diffStyle: "unified", wrap: false, preview: { markdown: "rendered", html: "rendered" } }), {
    name: "code-foundry.codeView",
    version: 1,
    // Only known fields of the right type (stores/persisted.ts); a kind missing from an older store gets its default.
    merge: (persisted, current) => {
      const p = persistedRecord(persisted);
      const preview = persistedRecord(p.preview);
      return {
        ...current,
        diffStyle: oneOf<DiffStyle>(p.diffStyle, ["unified", "split"], current.diffStyle),
        wrap: bool(p.wrap, current.wrap),
        preview: { markdown: oneOf(preview.markdown, MODES, current.preview.markdown), html: oneOf(preview.html, MODES, current.preview.html) },
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

export function setPreviewMode(kind: PreviewKind, mode: PreviewMode): void {
  useCodeViewStore.setState((s) => ({ preview: { ...s.preview, [kind]: mode } }));
}
