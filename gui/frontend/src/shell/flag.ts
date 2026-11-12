/**
 * The shell flag (docs/notes/shell-plan.md 2.11): the new window shell is on when
 * `localStorage["code-foundry.shell"] === "1"` or the page's URL has `?shell=1` (e2e and
 * `make drive`). Off by default until the cutover; with it off nothing reads the layout.
 * Read once per page load: turning it on or off takes a reload.
 */

export const SHELL_FLAG_KEY = "code-foundry.shell";

/** Whether the flag is on for this URL query and stored value. */
export function readShellFlag(search: string, stored: string | null): boolean {
  return stored === "1" || new URLSearchParams(search).get("shell") === "1";
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
