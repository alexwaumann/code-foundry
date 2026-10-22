import { CircleAlert, OctagonX, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { topFlag } from "@/lib/thread";
import { cn } from "@/lib/utils";
import { clearThreadFlag, showFlagSurface, useFlagSurfaceKind } from "@/stores/flagSurface";
import { useThreadsStore } from "@/stores/threads";

/**
 * The thread's top plugin flag in its header (docs/notes/plugins-11-gui-gaps.md): the
 * plugin's display name and the reason, amber for attention and red for error, text only
 * (no filled badge), the same flag the sidebar's line 2 shows. A click opens the plugin's
 * thread or pull request surface when one is available for the thread (plain text
 * otherwise); the × clears the flag. Nothing without a flag.
 */
export function FlagChip({ id }: { id: string }) {
  const flag = useThreadsStore(
    useShallow((s) => {
      const f = topFlag(s.byId[id] ?? {});
      return f ? { plugin: f.plugin, pluginName: f.pluginName, level: f.level, reason: f.reason } : null;
    }),
  );
  const surface = useFlagSurfaceKind(flag?.plugin ?? "", id);
  if (!flag) return null;
  const Icon = flag.level === "error" ? OctagonX : CircleAlert;
  const tone = flag.level === "error" ? "text-cf-error" : "text-cf-warning";
  const hoverTone = flag.level === "error" ? "hover:text-cf-error" : "hover:text-cf-warning";
  const words = (
    <>
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        <span className="font-medium">{flag.pluginName}</span>: {flag.reason}
      </span>
    </>
  );
  return (
    <span className={cn("flex h-[22px] max-w-80 min-w-0 shrink-[3] items-center text-caption-sm", tone)} data-testid="thread-flag" data-level={flag.level} data-plugin={flag.plugin}>
      {surface ? (
        <button
          type="button"
          className="flex min-w-0 items-center gap-[5px] rounded-sm px-1 outline-none hover:underline focus-visible:ring-1 focus-visible:ring-cf-focus"
          onClick={() => {
            showFlagSurface(surface, id);
          }}
          data-testid="thread-flag-open"
          data-surface={surface}
        >
          {words}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-[5px] px-1">{words}</span>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn("size-5 shrink-0 opacity-70 hover:bg-transparent hover:opacity-100 dark:hover:bg-transparent", tone, hoverTone)}
        aria-label={`Clear ${flag.pluginName}'s flag`}
        onClick={() => void clearThreadFlag(id, flag.plugin)}
        data-testid="thread-flag-clear"
      >
        <X aria-hidden />
      </Button>
    </span>
  );
}
