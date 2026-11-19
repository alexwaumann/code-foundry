import type { MouseEvent, ReactNode } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tip } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { notify } from "@/lib/notify";
import { openUrl } from "@/stores/gh";

/**
 * A link to a web page (thread and pull request markdown, a plugin's span): a real `<a href>`
 * that never navigates the app's own webview. A click opens the browser through openUrl
 * (view.open.url); with `open`, a plain click asks it first and the browser opens only when it
 * declines, and a cmd, ctrl or middle click always opens the browser.
 *
 * A right-click shows the app's menu, Open in browser and Copy link, instead of WebKit's,
 * whose Open Link loaded the page in place of the app (docs/notes/link-menu-nav-guard.md),
 * even with text selected across the link. Only links: a selection of plain text, inputs and
 * the composer keep the system menu.
 */
export function WebLink({
  url,
  tip,
  className,
  open,
  children,
}: {
  url: string;
  /** The tooltip; none when the link's text already says where it goes. */
  tip?: string | undefined;
  className?: string | undefined;
  open?: ((url: string) => boolean) | undefined;
  children?: ReactNode;
}) {
  return (
    <ContextMenu>
      <Tip label={tip}>
        <ContextMenuTrigger asChild>
          <a
            href={url}
            className={className}
            onClick={(e) => {
              // Never navigate the app's own webview: links open in the browser.
              e.preventDefault();
              if (open && isPlainClick(e) && open(url)) return;
              void openUrl(url);
            }}
            onAuxClick={
              open &&
              ((e) => {
                // A middle click is "somewhere else": the browser, as cmd+click.
                if (e.button !== 1) return;
                e.preventDefault();
                void openUrl(url);
              })
            }
          >
            {children}
          </a>
        </ContextMenuTrigger>
      </Tip>
      <ContextMenuContent
        data-testid="link-menu"
        // The menu is portalled, but its events still bubble through React to the link's
        // ancestors (a row that opens on click, a list's keys).
        onClick={stop}
        onKeyDown={stop}
        onDoubleClick={stop}
      >
        <ContextMenuItem data-testid="link-menu-open" onSelect={() => void openUrl(url)}>
          Open in browser
        </ContextMenuItem>
        <ContextMenuItem data-testid="link-menu-copy" onSelect={() => void copyLink(url)}>
          Copy link
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function stop(e: { stopPropagation: () => void }): void {
  e.stopPropagation();
}

/** A click with the main button and no cmd or ctrl (which mean "in the browser"). */
function isPlainClick(e: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey">): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey;
}

/** Copy link: the menu closed as it ran, so the copy is toasted (docs/notes/toast-success-rule.md). */
async function copyLink(url: string): Promise<void> {
  try {
    await copyText(url);
    notify({ level: "success", title: "Link copied", description: url });
  } catch {
    notify({ level: "error", title: "Copy failed" });
  }
}
