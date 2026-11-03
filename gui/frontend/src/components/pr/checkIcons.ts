import { CircleCheck, CircleDashed, CircleDot, CircleX } from "lucide-react";
import type { CheckView } from "@/api/gh";
import { useNow } from "@/lib/clock";
import { checkRunning } from "./model";

/** A check's icon per tone (checkTone). */
export const checkIcon = { success: CircleCheck, failure: CircleX, pending: CircleDot, skipped: CircleDashed } as const;

/** Ticks every second only while a running check's duration grows. */
export function useChecksClock(checks: readonly CheckView[]): number {
  return useNow(checks.some(checkRunning) ? 1000 : 30_000);
}
