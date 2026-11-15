import { MediaPlayer } from "./media/MediaPlayer";
import type { PreviewBodyProps } from "./types";

/** The video kind's body: the player with its frame (media/MediaPlayer.tsx). */
export function VideoBody(props: PreviewBodyProps) {
  return <MediaPlayer kind="video" {...props} />;
}

/** The audio kind's body: the player under the file's icon and name. */
export function AudioBody(props: PreviewBodyProps) {
  return <MediaPlayer kind="audio" {...props} />;
}
