import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

/**
 * State that a rule settles during render: `settle` takes what is stored to what this render
 * shows (the same object when nothing needs to change, and settling a settled value changes
 * nothing). A changed value is stored before React paints, so no frame shows the unsettled
 * one, which an effect repairing it after the paint would. The setter's updaters see the
 * settled value. docs/notes/derived-list-selection.md.
 */
export function useSettled<S>(initial: S | (() => S), settle: (stored: S) => S): [S, Dispatch<SetStateAction<S>>] {
  const [stored, setStored] = useState(initial);
  const settled = settle(stored);
  // React's "adjust state while rendering": it renders again at once with the settled value.
  if (settled !== stored) setStored(settled);
  return [settled, setStored];
}

interface Picked<K> {
  answer: unknown;
  key: K;
}

/**
 * A result list's selected row, worked out during render. The key is the user's (the keys
 * or the pointer) or the list's default, and `keep(key, sameAnswer)` says which row it is
 * now: sameAnswer is false once `answer` (what the rows answer: a query, a search key, the
 * first row; compared with Object.is) is not the one the key was kept for. Whatever keep
 * returns is what is kept, so a row it gave up for the default stays given up.
 */
export function useListSelection<K>(answer: unknown, keep: (key: K, sameAnswer: boolean) => K, initial: K): [K, (key: K) => void] {
  const [picked, setPicked] = useSettled<Picked<K>>(
    () => ({ answer, key: initial }),
    (s) => {
      const same = Object.is(s.answer, answer);
      const key = keep(s.key, same);
      return same && Object.is(key, s.key) ? s : { answer, key };
    },
  );
  const select = useCallback(
    (key: K) => {
      setPicked((s) => (Object.is(s.key, key) ? s : { ...s, key }));
    },
    [setPicked],
  );
  return [picked.key, select];
}
