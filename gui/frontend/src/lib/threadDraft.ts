/**
 * The compose store key of a thread's follow-up draft. Apart from stores/threadActions.ts
 * (which re-exports it) so light modules (stores/fileFinder.ts, which keys/bindings.ts
 * imports) need not pull the compose store in.
 */
export function threadDraftKey(threadId: string): string {
  return `thread:${threadId}`;
}
