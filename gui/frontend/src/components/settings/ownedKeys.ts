/**
 * Settings another field's key editor (keyEditors) edits, by key: the settings page lists
 * them under no row of their own and search does not find them. They stay in the file,
 * the CLI and the schema.
 */
export const OWNED_KEYS: ReadonlySet<string> = new Set([
  // The backdrop row's gallery picks the image.
  "appearance.backdrop_file",
]);
