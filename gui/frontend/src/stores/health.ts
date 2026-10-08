import { create } from "zustand";
import { ping, type HealthView } from "@/api/health";

export type HealthStatus = "connecting" | "ok" | "error";

interface HealthState {
  status: HealthStatus;
  health: HealthView | null;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useHealthStore = create<HealthState>()((set) => ({
  status: "connecting",
  health: null,
  error: null,
  refresh: async () => {
    try {
      const health = await ping();
      set({ status: "ok", health, error: null });
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
