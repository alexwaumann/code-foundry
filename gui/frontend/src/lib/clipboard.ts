/**
 * Copies text. Uses the async Clipboard API when the page may (secure context), else
 * falls back to execCommand("copy") on a temporary textarea, which WKWebView allows
 * inside a key event handler.
 */
export async function copyText(text: string): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && "clipboard" in navigator && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // fall through
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(ta);
  ta.select();
  try {
    // Deprecated but still the only synchronous copy path in non-secure WKWebView pages.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    document.execCommand("copy");
  } finally {
    ta.remove();
    prev?.focus();
  }
}
