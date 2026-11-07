import { useContext, useEffect, useRef, type PointerEventHandler, type ReactNode } from "react";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { navId, NavContext, type NavCtx } from "./nav";

export function NavProvider({ value, children }: { value: NavCtx; children: ReactNode }) {
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

/**
 * One navigable row. Click moves the cursor (or activates, with activateOnClick);
 * double-click activates; cmd+click runs onCmdClick when given. The cursor row is
 * highlighted and scrolled into view when it gets there. A `passive` row has no click (it still tints on hover,
 * so the pointer finds its right-click menu): only the keyboard (and that menu, RowContextMenu)
 * moves the cursor onto it, as on a project page's Checkouts table. `tip` is a hover tooltip for what the row hides (a
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
  onPointerEnter,
  onPointerLeave,
}: {
  navKey: string;
  className?: string;
  children: ReactNode;
  tip?: string;
  tipWhenTruncated?: boolean;
  activateOnClick?: boolean;
  passive?: boolean;
  onCmdClick?: () => void;
  onPointerEnter?: PointerEventHandler<HTMLElement>;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
}) {
  const { cursorKey, setCursor, activate } = useContext(NavContext);
  const selected = cursorKey === navKey;
  const ref = useRef<HTMLDivElement>(null);
  // When the cursor lands here, not when the row mounts: a virtualized list mounts the cursor's
  // row as it is scrolled towards, and that must not pull the list back to it.
  const wasSelected = useRef(selected);
  useEffect(() => {
    if (selected && !wasSelected.current) ref.current?.scrollIntoView({ block: "nearest" });
    wasSelected.current = selected;
  }, [selected]);
  const row = (
    <div
      ref={ref}
      id={navId(navKey)}
      role="option"
      aria-selected={selected}
      data-nav-key={navKey}
      className={cn("cursor-default rounded-sm", selected ? "bg-cf-control-hover text-cf-text ring-1 ring-cf-focus/40" : "hover:bg-cf-control-hover/50", className)}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
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
