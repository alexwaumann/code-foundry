/**
 * The player's mock fixture (docs/notes/file-previews-7-media.md): a `.webm` that is no video,
 * for the state that says WebKit cannot play a file. The playable clip and tone are mock/media/.
 */
const enc = new TextEncoder();

/** Not a WebM: the daemon streams it by its name, and the element reports it cannot decode it. */
export const UNPLAYABLE_WEBM = enc.encode("This is not a video, whatever its name says.\n".repeat(64));
