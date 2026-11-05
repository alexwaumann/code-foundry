import { useEffect, useRef, useState } from "react";

/**
 * A cmdk list whose rows arrive after the search (a daemon's answer): the controlled value.
 * cmdk picks the first row when the input changes, which is the old list's, and does not
 * look again when the answer replaces the rows. So the first row of each new list takes
 * over here, and whenever the selected row leaves the list; otherwise the selection stays
 * where the keys or the pointer moved it. keys should be stable between lists.
 */
export function useFirstRowSelection(keys: readonly string[]): [string, (value: string) => void] {
  const [selected, setSelected] = useState("");
  const first = keys[0] ?? "";
  const shownFirst = useRef(first);
  useEffect(() => {
    const moved = shownFirst.current !== first;
    shownFirst.current = first;
    setSelected((cur) => (moved || !keys.includes(cur) ? first : cur));
  }, [keys, first]);
  return [selected, setSelected];
}
