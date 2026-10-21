/**
 * People recently asked to review, per repository: the reviewer picker's Recent group.
 * Added (moved to the front) when the picker requests a review successfully, never on a
 * withdraw; removed with the row's ×. Newest first, RECENT_REVIEWERS_MAX per repository.
 * Persisted (localStorage "code-foundry.reviewerRecents"); repositories are never pruned.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ReviewerKindView } from "@/api/gh";
import { isRecord, persistedRecord, recordOf } from "./persisted";

export interface RecentReviewer {
  login: string;
  name: string;
  avatarUrl: string;
  kind: ReviewerKindView;
}

export const RECENT_REVIEWERS_MAX = 8;

interface ReviewerRecentsState {
  /** Normalized repo slug → newest first. */
  bySlug: Readonly<Record<string, readonly RecentReviewer[]>>;
}

function recentReviewer(v: unknown): RecentReviewer | undefined {
  if (!isRecord(v) || typeof v.login !== "string" || !v.login || (v.kind !== "user" && v.kind !== "team")) return undefined;
  return { login: v.login, name: typeof v.name === "string" ? v.name : "", avatarUrl: typeof v.avatarUrl === "string" ? v.avatarUrl : "", kind: v.kind };
}

export const useReviewerRecentsStore = create<ReviewerRecentsState>()(
  persist((): ReviewerRecentsState => ({ bySlug: {} }), {
    name: "code-foundry.reviewerRecents",
    version: 1,
    // Only well-formed reviewers in lists (stores/persisted.ts).
    merge: (persisted, current) => ({
      ...current,
      bySlug: recordOf(persistedRecord(persisted).bySlug, (v) => {
        const list = Array.isArray(v) ? v.map(recentReviewer).filter((r) => r !== undefined) : [];
        return list.length > 0 ? list.slice(0, RECENT_REVIEWERS_MAX) : undefined;
      }),
    }),
  }),
);

const slugKey = (slug: string): string => slug.toLowerCase();
const same = (a: RecentReviewer, login: string, kind: ReviewerKindView): boolean => a.kind === kind && a.login.toLowerCase() === login.toLowerCase();

const EMPTY: readonly RecentReviewer[] = [];

/** One repository's recents (a stable empty list when there are none). */
export function useRecentReviewers(slug: string): readonly RecentReviewer[] {
  return useReviewerRecentsStore((s) => s.bySlug[slugKey(slug)] ?? EMPTY);
}

export function addRecentReviewer(slug: string, r: RecentReviewer): void {
  const key = slugKey(slug);
  useReviewerRecentsStore.setState((s) => {
    const rest = (s.bySlug[key] ?? EMPTY).filter((x) => !same(x, r.login, r.kind));
    const entry: RecentReviewer = { login: r.login, name: r.name, avatarUrl: r.avatarUrl, kind: r.kind };
    return { bySlug: { ...s.bySlug, [key]: [entry, ...rest].slice(0, RECENT_REVIEWERS_MAX) } };
  });
}

export function removeRecentReviewer(slug: string, login: string, kind: ReviewerKindView): void {
  const key = slugKey(slug);
  useReviewerRecentsStore.setState((s) => {
    const prev = s.bySlug[key];
    if (!prev?.some((x) => same(x, login, kind))) return s;
    const next = prev.filter((x) => !same(x, login, kind));
    if (next.length > 0) return { bySlug: { ...s.bySlug, [key]: next } };
    const { [key]: _gone, ...others } = s.bySlug;
    return { bySlug: others };
  });
}
