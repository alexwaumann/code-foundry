/** Most refs a picker lists at once: a repository can have thousands, and typing narrows them. */
export const REF_CHOICES_MAX = 100;

/** The refs to list for what was typed, case aside, at most REF_CHOICES_MAX; the exact match is the typed row's. */
export function refChoices(refs: readonly string[], query: string): string[] {
  const q = query.toLowerCase();
  const hits = q ? refs.filter((r) => r !== query && r.toLowerCase().includes(q)) : refs;
  return hits.slice(0, REF_CHOICES_MAX);
}
