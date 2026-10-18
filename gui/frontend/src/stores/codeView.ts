/**
 * How code and diffs render (components/code): unified or split diffs, and wrapped or
 * scrolled long lines. One choice for the whole app, not per tab. Persisted (localStorage
 * "code-foundry.codeView"); not settings: they are not in the file.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DiffStyle = "unified" | "split";

interface CodeViewState {
  diffStyle: DiffStyle;
  wrap: boolean;
}

export const useCodeViewStore = create<CodeViewState>()(
  persist((): CodeViewState => ({ diffStyle: "unified", wrap: false }), { name: "code-foundry.codeView", version: 1 }),
);

export function setDiffStyle(diffStyle: DiffStyle): void {
  useCodeViewStore.setState({ diffStyle });
}

export function setWrap(wrap: boolean): void {
  useCodeViewStore.setState({ wrap });
}
