import { useCallback, useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";

/** How long a copy button shows its check. */
export const COPIED_MS = 1500;

/**
 * A copy button's state: `copy(text)` puts `text` on the clipboard (lib/clipboard) and,
 * once it is there, `copied` is true for `ms`; another copy meanwhile restarts the wait.
 * Every copy icon button shows its check and "Copied" from it, with no toast
 * (docs/notes/copy-feedback.md). `copy` resolves false when the copy failed (nothing shown).
 */
export function useCopied(ms = COPIED_MS): { copied: boolean; copy: (text: string) => Promise<boolean> } {
  // The successful copies so far: each one starts a fresh wait; 0 is "never copied".
  const [stamp, setStamp] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (stamp === 0) return;
    const t = setTimeout(() => {
      setCopied(false);
    }, ms);
    return () => {
      clearTimeout(t);
    };
  }, [stamp, ms]);
  const copy = useCallback(async (text: string): Promise<boolean> => {
    try {
      await copyText(text);
    } catch {
      return false;
    }
    setCopied(true);
    setStamp((n) => n + 1);
    return true;
  }, []);
  return { copied, copy };
}
