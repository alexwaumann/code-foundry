import { useMemo } from "react";
import type { PullRequestDetailView } from "@/api/gh";
import { useNow } from "@/lib/clock";
import { useViewerLogin } from "@/stores/gh";
import { detailFresh, readiness, type Readiness } from "./readiness";
import { seedReadiness, type SeedReadiness } from "./seed";

/** The detail's readiness on its own 30 s clock (the ages in the merged and closed words). */
export function useReadiness(d: PullRequestDetailView): Readiness {
  const viewer = useViewerLogin();
  const clock = useNow(30_000);
  return useMemo(() => readiness(d, viewer, detailFresh(d), clock), [d, viewer, clock]);
}

/** A seeded detail's readiness (seed.ts): no verdict for an open pull request, no buttons. */
export function useSeedReadiness(d: PullRequestDetailView): SeedReadiness {
  const viewer = useViewerLogin();
  const clock = useNow(30_000);
  return useMemo(() => seedReadiness(d, viewer, clock), [d, viewer, clock]);
}
