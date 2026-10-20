import type { ReactNode } from "react";
import { Kbd } from "@/components/ui/kbd";
import { openSurface, type GroupIndex } from "@/stores/panel";
import { useAvailability, type SurfaceContext, type SurfaceSpec } from "@/surfaces/registry";
import { keepPanelFocus, surfaceContext } from "./surfaceList";

/**
 * One entry of the empty panel's surface list. Its availability is a hook, so it follows
 * the stores the surface reads. It opens in `group` (default: the focused one). `trailing`
 * replaces the hotkey (a plugin's mark).
 */
export function SurfaceRow({ spec, ctx, group, trailing }: { spec: SurfaceSpec; ctx: SurfaceContext; group?: GroupIndex; trailing?: ReactNode }) {
  const availability = useAvailability(spec, ctx);
  if (availability === "hidden") return null;
  const enabled = availability === "enabled";
  return (
    <li>
      <button
        type="button"
        disabled={!enabled}
        data-surface={spec.kind}
        data-availability={availability}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-label enabled:hover:bg-accent disabled:cursor-default disabled:opacity-45"
        onClick={(e) => {
          const now = surfaceContext(ctx.panelKey);
          const tab = spec.openDefault(now);
          if (!tab || spec.available(now) !== "enabled") return;
          keepPanelFocus(e.currentTarget);
          openSurface(ctx.panelKey, tab, { group });
        }}
      >
        <spec.icon className="size-4 text-muted-foreground" aria-hidden />
        <span className="flex-1 truncate">{spec.title}</span>
        {trailing ?? (spec.hotkey && <Kbd>{spec.hotkey.toUpperCase()}</Kbd>)}
      </button>
    </li>
  );
}
