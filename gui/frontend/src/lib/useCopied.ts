import { useCallback, useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { notify } from "@/lib/notify";

/** How long a copy button shows its check. */
export const COPIED_MS = 1500;

/**
 * A visible copy control's state: `copy(text)` puts `text` on the clipboard (lib/clipboard)
 * and, once it is there, `copied` is true for `ms`; another copy meanwhile restarts the wait.
 * The control shows the result itself (components/ui/copy-button: a check in the success
 * colour and "Copied"), with no toast; a failed copy toasts "Copy failed" and resolves false
 * (docs/notes/toast-success-rule.md).
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
      notify({ level: "error", title: "Copy failed" });
      return false;
    }
    setCopied(true);
    setStamp((n) => n + 1);
    return true;
  }, []);
  return { copied, copy };
}
