import { create } from "zustand";
import { ping, type HealthView } from "@/api/health";
import { wakeAllStreams } from "@/api/stream";

export type HealthStatus = "connecting" | "ok" | "error";

interface HealthState {
  status: HealthStatus;
  health: HealthView | null;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useHealthStore = create<HealthState>()((set, get) => ({
  status: "connecting",
  health: null,
  error: null,
  refresh: async () => {
    try {
      const health = await ping();
      const back = get().status !== "ok";
      set({ status: "ok", health, error: null });
      // The daemon answers again: streams waiting out a backoff reconnect now, not when
      // their own timers run out (docs/notes/streams-wake-on-health.md).
      if (back) wakeAllStreams();
    } catch (err) {
      set({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  },
}));

/** Polls HealthService.Ping every intervalMs. Returns a stop function. */
export function startHealthPolling(intervalMs = 2000): () => void {
  const { refresh } = useHealthStore.getState();
  void refresh();
  const id = setInterval(() => void refresh(), intervalMs);
  return () => {
    clearInterval(id);
  };
}
