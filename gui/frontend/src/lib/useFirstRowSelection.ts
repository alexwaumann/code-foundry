import { useListSelection } from "./useListSelection";

/**
 * A cmdk list whose rows arrive after the search (a daemon's answer): the controlled value.
 * cmdk 1.1.1 selects the first row on screen when the input changes, which is the old
 * list's, and only looks again when the selected row unmounts. So the first row of each new
 * list takes over here, and whenever the selected row leaves the list; otherwise the
 * selection stays where the keys or the pointer moved it. Worked out during render
 * (useListSelection), so a new list never shows the old selection for a frame; cmdk takes
 * the controlled value in a layout effect. keys should be stable between lists.
 */
export function useFirstRowSelection(keys: readonly string[]): [string, (value: string) => void] {
  const first = keys[0] ?? "";
  return useListSelection<string>(first, (cur, sameFirst) => (sameFirst && keys.includes(cur) ? cur : first), "");
}
