/**
 * The shell flag (docs/notes/shell-plan.md 2.11): the window shell draws the window by default
 * since the cutover (docs/notes/shell-20-cutover.md). `?shell=0` in the page's URL, or
 * `localStorage["code-foundry.shell"] === "0"` (the palette's "Toggle new shell (preview)"),
 * gives the classic window for one more PR; `?shell=1` wins over the stored value. With it off
 * nothing reads the layout. Read once per page load: turning it on or off takes a reload.
 */

export const SHELL_FLAG_KEY = "code-foundry.shell";

/** Whether the flag is on for this URL query and stored value: on unless "0" turns it off. */
export function readShellFlag(search: string, stored: string | null): boolean {
  const param = new URLSearchParams(search).get("shell");
  if (param === "0" || param === "1") return param === "1";
  return stored !== "0";
}

function storedFlag(): string | null {
  try {
    return localStorage.getItem(SHELL_FLAG_KEY);
  } catch {
    // Storage can be blocked; the URL still decides.
    return null;
  }
}

let cached: boolean | null = null;

/** Whether the shell is on for this page load. */
export function shellOn(): boolean {
  cached ??= readShellFlag(typeof location === "undefined" ? "" : location.search, storedFlag());
  return cached;
}

/** Forgets the value read, so the next shellOn reads the URL and storage again (tests). */
export function resetShellFlag(): void {
  cached = null;
}
