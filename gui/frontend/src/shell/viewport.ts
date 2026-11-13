/**
 * Tells the daemon the size of the pane area (LayoutService.SetViewport), which placement,
 * restore and the direction verbs lay out with (docs/notes/shell-10-layout-slice.md). The pane grid
 * reports its box as it resizes; a burst sends one call once the size holds still, in layout px
 * (viewport px divided by the page zoom). The daemon forgets the size when it restarts, so the
 * layout slice sends the last one again on each snapshot.
 */
import { setLayoutViewport } from "@/api/layout";
import { zoomFactor } from "@/lib/zoom";

/** How long the size must hold still before it is sent. */
export const VIEWPORT_DEBOUNCE_MS = 200;

export interface ViewportReporter {
  /** The pane area's box in viewport px, as measured. */
  report(width: number, height: number): void;
  /** Sends the last size again (the daemon restarted), if one was reported. */
  resend(): void;
  /** Drops a pending send. */
  cancel(): void;
}

interface ReporterDeps {
  send: (width: number, height: number) => Promise<void>;
  zoom: () => number;
  delayMs: number;
}

export function createViewportReporter(deps: ReporterDeps): ViewportReporter {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The last size reported, in layout px. */
  let size: { w: number; h: number } | null = null;
  /** The last size sent. */
  let sent: { w: number; h: number } | null = null;

  const send = (): void => {
    timer = null;
    if (!size) return;
    const s = size;
    sent = s;
    deps.send(s.w, s.h).catch(() => {
      // Not sent (no daemon, an older one): the next report or snapshot tries again.
      if (sent === s) sent = null;
    });
  };

  return {
    report(width, height) {
      const z = deps.zoom();
      const w = width / z;
      const h = height / z;
      if (!(w > 0) || !(h > 0)) return;
      size = { w, h };
      if (timer) clearTimeout(timer);
      if (sent && sent.w === w && sent.h === h) {
        timer = null;
        return;
      }
      timer = setTimeout(send, deps.delayMs);
    },
    resend() {
      if (!size || timer) return;
      sent = null;
      send();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

const reporter = createViewportReporter({
  send: (w, h) => setLayoutViewport(w, h),
  zoom: zoomFactor,
  delayMs: VIEWPORT_DEBOUNCE_MS,
});

/** Reports the pane area's box (viewport px); the pane grid calls it from its resize observer. */
export function reportViewport(width: number, height: number): void {
  reporter.report(width, height);
}

/** Sends the last size again: the layout slice calls it on each snapshot. */
export function resendViewport(): void {
  reporter.resend();
}
