/**
 * The pull request diff tab (docs/notes/pr-diff-tab.md): one pull request's diff from GitHub,
 * in a tab of its own beside the pull request's. One tab per pull request, as the pull
 * request's tab is: the id comes from the slug in lower case and the number, so opening it
 * again finds it however the slug is spelled, and the file shown is a param. Pure.
 */
import { tabId, type Tab } from "@/shell/host";
import type { PrRef } from "./pullrequestTarget";

export const PR_DIFF_KIND = "prdiff";
export const PR_DIFF_TITLE = "Pull request diff";

export interface PrDiffTarget extends PrRef {
  /** The file shown, as the diff names it; "" until the tab has shown one, when it takes the first and keeps it. */
  file: string;
}

/** The id of a pull request's diff tab: one however the slug is spelled (shell/identity.ts prdiff). */
export function prDiffTabId(slug: string, number: number | string): string {
  return tabId(PR_DIFF_KIND, { number: String(number), slug: slug.toLowerCase() });
}

/** The tab for a pull request's diff: params { slug, number, path? }, titled "Diff #<number>". The slug param keeps its spelling. */
export function prDiffTab(t: PrRef & { file?: string }): Tab {
  const number = String(t.number);
  const params: Record<string, string> = { slug: t.slug, number };
  if (t.file) params.path = t.file;
  return { id: prDiffTabId(t.slug, number), kind: PR_DIFF_KIND, title: `Diff #${number}`, params };
}

/** What a pull request diff tab shows; null when its params do not name a pull request. */
export function prDiffOfTab(tab: Pick<Tab, "params">): PrDiffTarget | null {
  const slug = tab.params.slug ?? "";
  const number = Number(tab.params.number);
  if (!slug.includes("/") || !Number.isInteger(number) || number <= 0) return null;
  return { slug, number, file: tab.params.path ?? "" };
}
