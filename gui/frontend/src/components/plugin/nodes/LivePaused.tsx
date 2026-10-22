import { Pause, Unplug } from "lucide-react";
import { useStreamSlotsStore } from "@/api/streamSlots";
import { Button } from "@/components/ui/button";
import { INLINE_LIVE_MAX } from "../live";

/**
 * What a thread or terminal node shows in place of its live view when it holds no stream
 * (components/plugin/live.ts): over the inline budget (a muted note and Attach, which takes
 * the oldest live node's place), or waiting for one of the app's connections
 * (api/streamSlots.ts). While streams wait for one of the app's connections (a bottom
 * panel terminal or a second core stream took it, so a live node may be waiting too),
 * Attach is not offered: taking a slot would pause a node that streams for one that
 * waits. Off screen or leaving the view tab it is an empty box. Its z-10
 * covers the node's own content only: the thread and terminal nodes are `isolate`, so it
 * never paints over the surface's sticky header and tabs (also z-10) when scrolled under.
 */
export function LivePaused({ reason, kind, onAttach }: { reason: "budget" | "connections" | "hidden"; kind: "thread" | "terminal"; onAttach?: () => void }) {
  const starved = useStreamSlotsStore((s) => s.waiting.length > 0);
  if (reason === "hidden") return <div className="absolute inset-0 bg-cf-surface" aria-hidden data-testid="plugin-live-hidden" />;
  const Icon = reason === "budget" ? Pause : Unplug;
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 bg-cf-surface px-4 text-center" role="status" data-testid="plugin-live-paused" data-reason={reason}>
      <Icon className="size-4 text-cf-text-muted" aria-hidden />
      <p className="text-body-sm font-medium text-cf-text-muted">{reason === "budget" ? "Paused" : "Waiting for a connection"}</p>
      <p className="max-w-64 text-caption-sm">
        {reason !== "budget"
          ? "The app has as many live streams open as it can; this view attaches when one closes."
          : starved
            ? `Plugin views keep ${String(INLINE_LIVE_MAX)} threads and terminals live at once, and the app's connections are all in use now.`
            : `Plugin views keep ${String(INLINE_LIVE_MAX)} threads and terminals live at once. Attach this ${kind} to pause the oldest.`}
      </p>
      {reason === "budget" && !starved && onAttach && (
        <Button variant="ghost" size="xs" className="mt-1 text-cf-text-muted hover:text-cf-text" onClick={onAttach} data-testid="plugin-live-attach">
          Attach
        </Button>
      )}
    </div>
  );
}
