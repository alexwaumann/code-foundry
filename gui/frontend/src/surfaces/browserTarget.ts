/** The Browser surface's tab: one per panel, the page behind it named by the panel's key. */
import { makeTab, type Tab } from "@/stores/panel";

export const BROWSER_KIND = "browser";
export const BROWSER_TITLE = "Browser";

export function browserTab(): Tab {
  return makeTab(BROWSER_KIND, BROWSER_TITLE);
}
