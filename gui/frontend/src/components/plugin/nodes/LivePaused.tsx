import { Pause, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { INLINE_LIVE_MAX } from "../live";

/**
 * What a thread or terminal node shows in place of its live view when it holds no stream
 * (components/plugin/live.ts): over the inline budget (a muted note and Attach, which takes
 * the oldest live node's place), or waiting for one of the app's connections
 * (api/streamSlots.ts). Off screen or leaving the view tab it is an empty box.
 */
export function LivePaused({ reason, kind, onAttach }: { reason: "budget" | "connections" | "hidden"; kind: "thread" | "terminal"; onAttach?: () => void }) {
  if (reason === "hidden") return <div className="absolute inset-0 bg-pane" aria-hidden data-testid="plugin-live-hidden" />;
  const Icon = reason === "budget" ? Pause : Unplug;
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 bg-pane px-4 text-center" role="status" data-testid="plugin-live-paused" data-reason={reason}>
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      <p className="text-body-sm font-medium text-muted-foreground">{reason === "budget" ? "Paused" : "Waiting for a connection"}</p>
      <p className="max-w-64 text-caption-sm">
        {reason === "budget"
          ? `Plugin views keep ${String(INLINE_LIVE_MAX)} threads and terminals live at once. Attach this ${kind} to pause the oldest.`
          : "The app has as many live streams open as it can; this view attaches when one closes."}
      </p>
      {reason === "budget" && onAttach && (
        <Button variant="ghost" size="xs" className="mt-1 text-muted-foreground hover:text-foreground" onClick={onAttach} data-testid="plugin-live-attach">
          Attach
        </Button>
      )}
    </div>
  );
}
