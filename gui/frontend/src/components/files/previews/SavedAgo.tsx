import { ago } from "@/components/pr/model";
import { useNow } from "@/lib/clock";

/** "saved 2m ago" for a rendered file's meta; nothing when the time is not known. */
export function SavedAgo({ ms }: { ms: number | null }) {
  const now = useNow(30_000);
  return ms === null ? null : <>saved {ago(ms, now)}</>;
}
