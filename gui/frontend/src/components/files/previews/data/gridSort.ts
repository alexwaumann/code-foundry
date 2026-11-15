/**
 * The data grid's sort, by file path (DataGrid.tsx): view only, in memory, never written to
 * the file. Kept outside the grid so Copy contents (the kind's `copy`, which sees no body)
 * copies rows in the order shown. Each file has its own; a new file opens in file order.
 */
import { create } from "zustand";
import type { Sort } from "./table";

interface GridSortState {
  readonly byPath: Readonly<Record<string, Sort | undefined>>;
}

export const useGridSortStore = create<GridSortState>()(() => ({ byPath: {} }));

export function useGridSort(path: string): Sort | null {
  return useGridSortStore((s) => s.byPath[path] ?? null);
}

export function gridSortOf(path: string): Sort | null {
  return useGridSortStore.getState().byPath[path] ?? null;
}

export function setGridSort(path: string, sort: Sort | null): void {
  useGridSortStore.setState((s) => ({ byPath: { ...s.byPath, [path]: sort ?? undefined } }));
}
