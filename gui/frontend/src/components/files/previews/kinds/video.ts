import { FileVideo } from "lucide-react";
import { VideoBody } from "../MediaBody";
import { mediaMeta } from "../media/mediaFormat";
import type { PreviewKind } from "../types";

/**
 * Video: streamed from the daemon into our own player, no switch. The extensions are the
 * daemon's (internal/fsx/read.go mediaByExt): a read of one has `media` set and no bytes, and
 * an older daemon's read (bytes, no `media`) falls through to the binary state.
 */
const video: PreviewKind = {
  id: "video",
  match: { ext: ["mp4", "m4v", "mov", "webm"] },
  shows: (f) => f.media === true,
  modes: [{ id: "play", label: "Play" }],
  read: "stream",
  Body: VideoBody,
  meta: ({ file, path }) => mediaMeta(file.size, path, file.mime),
  edit: false,
  editor: false,
  icon: FileVideo,
};

export default video;
