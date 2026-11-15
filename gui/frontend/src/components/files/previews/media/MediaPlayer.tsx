import { useCallback, useEffect, useReducer, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { AudioLines, FileAudio, FileVideo, TriangleAlert } from "lucide-react";
import { FinderIcon } from "@/components/icons/AppIcon";
import { Button } from "@/components/ui/button";
import { tildify } from "@/lib/path";
import { cn } from "@/lib/utils";
import { stepVolume, toggleMuted, useMediaPlayerStore } from "@/stores/mediaPlayer";
import { revealInFinder } from "../../fileActions";
import { FileEmptyState } from "../../states";
import type { PreviewBodyProps } from "../types";
import { ControlBar } from "./ControlBar";
import { mediaMeta, rangesOf } from "./mediaFormat";
import { playerKeyAction, SEEK_STEP, type PlayerAction } from "./playerKeys";
import { errorOutcome, initialPlayerState, playerReducer } from "./playerState";
import { useFullscreen } from "./useFullscreen";
import { useMediaGrant } from "./useMediaGrant";

export type MediaKind = "video" | "audio";

/** Where a paused video is put to show its first frame (seconds; under a frame at any rate). */
const FIRST_FRAME = 0.001;

const HEADINGS: Readonly<Record<MediaKind, string>> = {
  video: "This video format cannot be played here",
  audio: "This audio format cannot be played here",
};

/**
 * A video or audio file in the File tab, streamed from the daemon (useMediaGrant: a URL the
 * element loads in ranges; the bytes never pass through the page), under our own control
 * bar. One stream per player on screen: a tab that is not showing is unmounted, and the
 * player lets go of its connection then. Two tabs of one file play independently (each its
 * element, its position); volume, mute and speed are one choice for all (stores/mediaPlayer).
 * A URL that dies (the daemon restarted) is asked for again and playback picks up where it
 * was; a file WebKit cannot decode gets a clear state, never a black box.
 */
export function MediaPlayer({ kind, file, path, name, place, reloads, onMeta }: PreviewBodyProps & { kind: MediaKind }) {
  const video = kind === "video";
  // A new version of the file, or Refresh, loads it again (keeping the position).
  const grant = useMediaGrant(place.dir, path, `${String(file.size)}:${String(file.modifiedAtMs)}:${String(reloads)}`);
  const [state, dispatch] = useReducer(playerReducer, initialPlayerState);
  const media = useRef<HTMLMediaElement | null>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Where to pick up once the next URL's metadata is in: set before the element loads another URL.
  const resume = useRef<{ at: number; play: boolean } | null>(null);
  // A drag of the scrubber: whether it was playing when the drag started (it plays again after).
  const drag = useRef<{ play: boolean } | null>(null);
  const fs = useFullscreen(rootRef);
  const canFullscreen = video && fs.available;
  const volume = useMediaPlayerStore((s) => s.volume);
  const muted = useMediaPlayerStore((s) => s.muted);
  const rate = useMediaPlayerStore((s) => s.rate);

  // A new answer (even the same URL) loads the element again.
  const { url, generation } = grant;
  useEffect(() => {
    const el = media.current;
    if (!el || url === null) return;
    if (resume.current === null && el.readyState >= HTMLMediaElement.HAVE_METADATA) resume.current = { at: el.currentTime, play: !el.paused };
    if (el.getAttribute("src") === url) el.load();
    else el.src = url;
    dispatch({ type: "source" });
  }, [url, generation]);

  // Unmounted (the tab hidden or closed): stop, and drop the connection with the source.
  useEffect(() => {
    const el = media.current;
    return () => {
      if (!el) return;
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, []);

  useEffect(() => {
    const el = media.current;
    if (!el) return;
    el.volume = volume;
    el.muted = muted;
  }, [volume, muted]);
  useEffect(() => {
    const el = media.current;
    if (!el) return;
    // A load resets playbackRate to the default, so both.
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
  }, [rate]);

  const { facts } = state;
  useEffect(() => {
    if (facts) onMeta(mediaMeta(file.size, path, file.mime, facts));
  }, [facts, file.size, file.mime, path, onMeta]);

  const toggle = useCallback(() => {
    const el = media.current;
    if (!el || !el.getAttribute("src")) return;
    if (el.paused || el.ended) el.play().catch(() => undefined);
    else el.pause();
  }, []);
  const seekBy = (delta: number) => {
    const el = media.current;
    if (!el || !Number.isFinite(el.duration)) return;
    const t = Math.min(el.duration, Math.max(0, el.currentTime + delta));
    el.currentTime = t;
    dispatch({ type: "seek", time: t });
  };
  const actions: Readonly<Record<PlayerAction, () => void>> = {
    toggle,
    back: () => {
      seekBy(-SEEK_STEP);
    },
    forward: () => {
      seekBy(SEEK_STEP);
    },
    louder: () => {
      stepVolume(1);
    },
    quieter: () => {
      stepVolume(-1);
    },
    mute: toggleMuted,
    fullscreen: fs.toggle,
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const action = playerKeyAction(e.nativeEvent, canFullscreen);
    if (action === null) return;
    e.preventDefault();
    e.stopPropagation();
    actions[action]();
  };

  const onScrub = (v: number) => {
    const el = media.current;
    if (!el) return;
    if (drag.current === null) {
      drag.current = { play: !el.paused };
      el.pause();
    }
    dispatch({ type: "scrub", value: v });
    // The frame follows the thumb (a keyframe seek where WebKit has one); audio seeks once, at the end.
    if (video) {
      if (typeof el.fastSeek === "function") el.fastSeek(v);
      else el.currentTime = v;
    }
  };
  const onScrubEnd = (v: number) => {
    const el = media.current;
    const d = drag.current;
    drag.current = null;
    if (!el) return;
    el.currentTime = v;
    dispatch({ type: "scrub", value: v });
    dispatch({ type: "scrubEnd" });
    if (d?.play) el.play().catch(() => undefined);
  };

  const events = {
    onLoadedMetadata: (e: SyntheticEvent<HTMLMediaElement>) => {
      const el = e.currentTarget;
      const r = resume.current;
      resume.current = null;
      if (r) {
        el.currentTime = Number.isFinite(el.duration) ? Math.min(r.at, el.duration) : r.at;
        if (r.play) el.play().catch(() => undefined);
      }
      const v = el instanceof HTMLVideoElement ? el : null;
      // The Wails window's WKWebView paints a paused video black until it decodes a frame,
      // which preload="metadata" stops short of: a seek just past the start shows the first.
      if (!r && v && el.currentTime === 0) el.currentTime = FIRST_FRAME;
      dispatch({ type: "meta", facts: { duration: el.duration, width: v?.videoWidth ?? 0, height: v?.videoHeight ?? 0 } });
      dispatch({ type: "time", time: el.currentTime, ranges: rangesOf(el.buffered) });
    },
    onDurationChange: (e: SyntheticEvent<HTMLMediaElement>) => {
      dispatch({ type: "duration", duration: e.currentTarget.duration });
    },
    onTimeUpdate: (e: SyntheticEvent<HTMLMediaElement>) => {
      dispatch({ type: "time", time: e.currentTarget.currentTime, ranges: rangesOf(e.currentTarget.buffered) });
    },
    onProgress: (e: SyntheticEvent<HTMLMediaElement>) => {
      dispatch({ type: "progress", ranges: rangesOf(e.currentTarget.buffered) });
    },
    onPlay: () => {
      dispatch({ type: "play" });
    },
    onPause: () => {
      dispatch({ type: "pause" });
    },
    onEnded: () => {
      dispatch({ type: "ended" });
    },
    onError: (e: SyntheticEvent<HTMLMediaElement>) => {
      const el = e.currentTarget;
      // Only the URL on the element now: a release (src removed) reports an error too.
      if (!el.getAttribute("src")) return;
      switch (errorOutcome(state, el.error?.code ?? 0)) {
        case "ignore":
          return;
        case "regrant":
          resume.current ??= { at: state.time, play: state.playing };
          grant.regrant();
          return;
        case "unplayable":
          dispatch({ type: "unplayable" });
          return;
        case "failed":
          dispatch({ type: "failed" });
      }
    },
  };

  const failure = grant.error ?? (state.status === "failed" ? "The connection to the daemon dropped while loading the file." : null);
  const blocked = failure !== null || state.status === "unplayable";
  const reveal = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        revealInFinder(place);
      }}
    >
      <FinderIcon aria-hidden />
      Open in Finder
    </Button>
  );

  return (
    <div
      ref={(el) => {
        rootRef.current = el;
        setRoot(el);
      }}
      tabIndex={0}
      // Bare keys inside are the player's (keys/bindings.ts chordFires).
      data-keys-local=""
      className="flex min-h-0 flex-1 flex-col outline-none focus-visible:ring-2 focus-visible:ring-cf-focus focus-visible:ring-inset"
      data-testid="media-player"
      data-kind={kind}
      data-status={blocked ? (failure !== null ? "failed" : "unplayable") : state.status}
      data-playing={state.playing || undefined}
      onKeyDown={onKey}
    >
      {state.status === "unplayable" && failure === null && (
        <FileEmptyState icon={video ? FileVideo : FileAudio} heading={HEADINGS[kind]} detail={tildify(path)} testId="file-media-unplayable">
          {reveal}
        </FileEmptyState>
      )}
      {failure !== null && (
        <FileEmptyState icon={TriangleAlert} heading={video ? "Cannot play the video" : "Cannot play the audio"} detail={failure} testId="file-media-error">
          <Button variant="outline" size="sm" onClick={grant.regrant} data-testid="file-media-retry">
            Retry
          </Button>
          {reveal}
        </FileEmptyState>
      )}
      <div
        className={cn("flex min-h-0 flex-1 items-center justify-center", video ? "bg-cf-canvas p-4" : "p-6", blocked && "hidden")}
        onClick={video ? toggle : undefined}
        data-testid="media-stage"
      >
        {video ? (
          <video ref={(el) => void (media.current = el)} preload="metadata" playsInline className="size-full object-contain" aria-label={name} data-testid="media-element" {...events} />
        ) : (
          <>
            <audio ref={(el) => void (media.current = el)} preload="metadata" aria-label={name} data-testid="media-element" {...events} />
            <div className="flex max-w-full min-w-0 flex-col items-center gap-3 text-center">
              <div className="flex size-20 items-center justify-center rounded-2xl bg-cf-surface-sunken">
                <AudioLines className={cn("size-9", state.playing ? "text-cf-text" : "text-cf-text-muted")} aria-hidden />
              </div>
              <p className="max-w-full truncate text-title">{name}</p>
            </div>
          </>
        )}
      </div>
      {!blocked && (
        <ControlBar
          playing={state.playing}
          time={state.scrub ?? state.time}
          duration={facts?.duration ?? Number.NaN}
          buffered={state.buffered}
          onToggle={toggle}
          onScrub={onScrub}
          onScrubEnd={onScrubEnd}
          onKey={onKey}
          fullscreen={canFullscreen ? { active: fs.active, toggle: fs.toggle } : undefined}
          portal={fs.active ? root : null}
        />
      )}
    </div>
  );
}
