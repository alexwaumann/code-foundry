/**
 * Where a daemon notification's button leads (UiIntent.Notify.link, docs/notes/memory-page.md):
 * "<kind>:<target>". A registry, not a switch: a new kind is one entry. A link this window
 * does not know gets no button.
 */
import { openSettingsPage } from "./views";

const kinds: Readonly<Record<string, (target: string) => void>> = {
  // "settings:memory": that Settings page.
  settings: (page) => {
    openSettingsPage(page);
  },
};

/** What clicking the link does; null for a link this window does not know (or an empty target). */
export function notifyLinkAction(link: string): (() => void) | null {
  const at = link.indexOf(":");
  if (at <= 0) return null;
  const open = kinds[link.slice(0, at)];
  const target = link.slice(at + 1);
  if (!open || !target) return null;
  return () => {
    open(target);
  };
}
