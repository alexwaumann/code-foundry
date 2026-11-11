import { create } from "zustand";
import type { ShotTarget } from "./controller";

/** The surface the shot page shows: its watch and target (null between requests). */
export const useShotStage = create<{ stage: { watchKey: string; target: ShotTarget } | null }>(() => ({ stage: null }));
