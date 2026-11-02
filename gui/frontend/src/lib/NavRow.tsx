import { useContext, useEffect, useRef, type ReactNode } from "react";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { navId, NavContext, type NavCtx } from "./nav";

export function NavProvider({ value, children }: { value: NavCtx; children: ReactNode }) {
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

/**
 * One navigable row. Click moves the cursor (or activates, with activateOnClick);
 * double-click activates; cmd+click runs onCmdClick when given. The cursor row is
 * highlighted and scrolled into view. A `passive` row has neither click nor hover tint: only
 * the keyboard (and its right-click menu, RowContextMenu) moves the cursor onto it, as on a
 * project page's Checkouts table. `tip` is a hover tooltip for what the row hides (a
 * full path); with `tipWhenTruncated` it opens only while the row's text is cut short. The
 * rows are not focusable (the list uses aria-activedescendant), so arrow keys never open it.
 */
export function NavRow({
  navKey,
  className,
  children,
  tip,
  tipWhenTruncated = false,
  activateOnClick = false,
  passive = false,
  onCmdClick,
}: {
  navKey: string;
  className?: string;
  children: ReactNode;
  tip?: string;
  tipWhenTruncated?: boolean;
  activateOnClick?: boolean;
  passive?: boolean;
  onCmdClick?: () => void;
}) {
  const { cursorKey, setCursor, activate } = useContext(NavContext);
  const selected = cursorKey === navKey;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const row = (
    <div
      ref={ref}
      id={navId(navKey)}
      role="option"
      aria-selected={selected}
      data-nav-key={navKey}
      className={cn("cursor-default rounded-sm", selected ? "bg-cf-control-hover text-cf-text ring-1 ring-cf-focus/40" : !passive && "hover:bg-cf-control-hover/50", className)}
      onClick={
        passive
          ? undefined
          : (e) => {
              if (e.metaKey && onCmdClick) {
                setCursor(navKey);
                onCmdClick();
              } else if (activateOnClick) activate(navKey);
              else setCursor(navKey);
            }
      }
      onDoubleClick={
        passive
          ? undefined
          : () => {
              activate(navKey);
            }
      }
    >
      {children}
    </div>
  );
  return tip === undefined ? row : (
    <Tip label={tip} align="start" whenTruncated={tipWhenTruncated}>
      {row}
    </Tip>
  );
}
