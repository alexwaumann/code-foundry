/**
 * Fields a section keeps behind its Advanced disclosure, by "<page>/<section>". Display only,
 * like the hidden fields: the settings search still finds them, each as a row of its own.
 */
export const sectionAdvanced: Readonly<Partial<Record<string, ReadonlySet<string>>>> = {
  "general/dictation": new Set(["dictation.spoken_symbols", "dictation.spoken_formatting"]),
};
