import { FileAudio } from "lucide-react";
import { AudioBody } from "../MediaBody";
import { mediaMeta } from "../media/mediaFormat";
import type { PreviewKind } from "../types";

/** Audio: streamed from the daemon into our own player, no switch (as video.ts). */
const audio: PreviewKind = {
  id: "audio",
  match: { ext: ["mp3", "wav", "m4a", "aac", "ogg", "flac"] },
  shows: (f) => f.media === true,
  modes: [{ id: "play", label: "Play" }],
  read: "stream",
  Body: AudioBody,
  meta: ({ file, path }) => mediaMeta(file.size, path, file.mime),
  edit: false,
  editor: false,
  icon: FileAudio,
};

export default audio;
