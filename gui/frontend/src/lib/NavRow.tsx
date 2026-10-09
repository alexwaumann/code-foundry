import { useContext, useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { navId, NavContext, type NavCtx } from "./nav";

export function NavProvider({ value, children }: { value: NavCtx; children: ReactNode }) {
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

/**
 * One navigable row. Click moves the cursor (or activates, with activateOnClick);
 * double-click activates; cmd+click runs onCmdClick when given. The cursor row is
 * highlighted and scrolled into view.
 */
export function NavRow({
  navKey,
  className,
  children,
  title,
  activateOnClick = false,
  onCmdClick,
}: {
  navKey: string;
  className?: string;
  children: ReactNode;
  title?: string;
  activateOnClick?: boolean;
  onCmdClick?: () => void;
}) {
  const { cursorKey, setCursor, activate } = useContext(NavContext);
  const selected = cursorKey === navKey;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <div
      ref={ref}
      id={navId(navKey)}
      role="option"
      aria-selected={selected}
      data-nav-key={navKey}
      title={title}
      className={cn("cursor-default rounded-sm", selected ? "bg-accent text-accent-foreground ring-1 ring-ring/40" : "hover:bg-accent/50", className)}
      onClick={(e) => {
        if (e.metaKey && onCmdClick) {
          setCursor(navKey);
          onCmdClick();
        } else if (activateOnClick) activate(navKey);
        else setCursor(navKey);
      }}
      onDoubleClick={() => {
        activate(navKey);
      }}
    >
      {children}
    </div>
  );
}
