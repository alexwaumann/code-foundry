import { useState, type KeyboardEvent } from "react";
import { Maximize, Minimize, Pause, Play, Volume1, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { Tip } from "@/components/ui/tooltip";
import { PLAYBACK_RATES, setPlaybackRate, setVolume, toggleMuted, useMediaPlayerStore } from "@/stores/mediaPlayer";
import { formatTime, rateLabel } from "./mediaFormat";

const iconButton = "text-cf-text-secondary hover:text-cf-text [&_svg]:size-3.5";

export interface ControlBarProps {
  playing: boolean;
  /** The clock: the drag's value while scrubbing. */
  time: number;
  /** Seconds; NaN until known, Infinity for a stream with no set length (the scrubber is off for both). */
  duration: number;
  /** Where the buffered stretch at the playhead ends. */
  buffered: number;
  onToggle: () => void;
  onScrub: (value: number) => void;
  onScrubEnd: (value: number) => void;
  /** The player's keys, for the scrubber: its Left and Right seek by the player's step rather than the slider's. */
  onKey: (e: KeyboardEvent<HTMLElement>) => void;
  /** Full screen, for video where the webview allows it; absent hides the button. */
  fullscreen?: { active: boolean; toggle: () => void };
  /** Where the speed menu is portalled: the player in full screen (nothing else is drawn then), else the body. */
  portal: HTMLElement | null;
}

/**
 * The player's bar (the sketch's): play or pause, elapsed time, the scrubber with what is
 * buffered, the length, playback speed, volume and full screen. Ours, not WebKit's controls,
 * so it looks and keys the same in every pane and theme.
 */
export function ControlBar({ playing, time, duration, buffered, onToggle, onScrub, onScrubEnd, onKey, fullscreen, portal }: ControlBarProps) {
  const known = Number.isFinite(duration) && duration > 0;
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-cf-divider bg-cf-surface px-2.5" data-testid="media-controls">
      <Tip label={playing ? "Pause" : "Play"}>
        <Button variant="ghost" size="icon-xs" className={iconButton} aria-label={playing ? "Pause" : "Play"} data-testid="media-play" onClick={onToggle}>
          {playing ? <Pause className="fill-current" aria-hidden /> : <Play className="fill-current" aria-hidden />}
        </Button>
      </Tip>
      <span className="shrink-0 text-caption-sm text-cf-text-secondary tabular-nums" data-testid="media-time">
        {formatTime(time)}
      </span>
      <Scrubber value={time} duration={known ? duration : 0} buffered={buffered} onScrub={onScrub} onScrubEnd={onScrubEnd} onKey={onKey} />
      <span className="shrink-0 text-caption-sm text-cf-text-secondary tabular-nums" data-testid="media-duration">
        {known ? formatTime(duration) : "--:--"}
      </span>
      <SpeedMenu portal={portal} />
      <VolumeControl />
      {fullscreen && (
        <Tip label={fullscreen.active ? "Exit full screen" : "Full screen"}>
          <Button variant="ghost" size="icon-xs" className={iconButton} aria-label={fullscreen.active ? "Exit full screen" : "Full screen"} data-testid="media-fullscreen" onClick={fullscreen.toggle}>
            {fullscreen.active ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
          </Button>
        </Tip>
      )}
    </div>
  );
}

/**
 * The scrubber: a slider over the length (click or drag to seek, Home and End), drawn over a
 * track of its own that shows the buffered stretch. Left and Right seek by the player's step.
 */
function Scrubber({ value, duration, buffered, onScrub, onScrubEnd, onKey }: { value: number; duration: number; buffered: number; onScrub: (v: number) => void; onScrubEnd: (v: number) => void; onKey: (e: KeyboardEvent<HTMLElement>) => void }) {
  const pct = (x: number) => (duration > 0 ? Math.min(100, Math.max(0, (x / duration) * 100)) : 0);
  return (
    <div className="relative flex h-6 min-w-12 flex-1 items-center" data-testid="media-scrubber">
      <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-cf-control-active">
        <div className="h-full bg-cf-text/25" style={{ width: `${String(pct(buffered))}%` }} data-testid="media-buffered" />
      </div>
      <Slider
        value={[Math.min(value, duration)]}
        max={duration > 0 ? duration : 1}
        step={0.01}
        disabled={duration <= 0}
        thumbLabel="Seek"
        trackClassName="bg-transparent data-[orientation=horizontal]:h-1"
        rangeClassName="bg-cf-text"
        thumbClassName="size-3 border-0 bg-cf-text shadow-none hover:ring-2 focus-visible:ring-2"
        onValueChange={([v]) => {
          if (v !== undefined) onScrub(v);
        }}
        onValueCommit={([v]) => {
          if (v !== undefined) onScrubEnd(v);
        }}
        onKeyDown={onKey}
      />
    </div>
  );
}

/** The speed menu: 0.5× to 2×, remembered for every file (stores/mediaPlayer.ts). */
function SpeedMenu({ portal }: { portal: HTMLElement | null }) {
  const rate = useMediaPlayerStore((s) => s.rate);
  return (
    <DropdownMenu modal={false}>
      <Tip label="Playback speed">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" className="shrink-0 px-1.5 text-cf-text-secondary tabular-nums hover:text-cf-text" aria-label={`Playback speed ${rateLabel(rate)}`} data-testid="media-speed">
            {rateLabel(rate)}
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent container={portal} side="top" align="end" className="min-w-24" data-testid="media-speed-menu">
        <DropdownMenuRadioGroup
          value={String(rate)}
          onValueChange={(v) => {
            const r = PLAYBACK_RATES.find((x) => String(x) === v);
            if (r !== undefined) setPlaybackRate(r);
          }}
        >
          {PLAYBACK_RATES.map((r) => (
            <DropdownMenuRadioItem key={r} value={String(r)} className="tabular-nums" data-testid={`media-speed-${String(r)}`}>
              {rateLabel(r)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Volume: the speaker mutes and unmutes; its slider opens beside it while the pointer is over
 * the speaker or the keyboard is in it (Tab from the speaker), and stays open through a drag.
 * Inline rather than a popover, so it works the same in full screen.
 */
function VolumeControl() {
  const volume = useMediaPlayerStore((s) => s.volume);
  const muted = useMediaPlayerStore((s) => s.muted);
  const [dragging, setDragging] = useState(false);
  const silent = muted || volume === 0;
  const Icon = silent ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const label = silent ? "Unmute" : "Mute";
  return (
    <div className="group/volume flex shrink-0 items-center" data-testid="media-volume" data-open={dragging || undefined}>
      <Tip label={label}>
        <Button variant="ghost" size="icon-xs" className={iconButton} aria-label={label} aria-pressed={silent} data-testid="media-mute" onClick={toggleMuted}>
          <Icon aria-hidden />
        </Button>
      </Tip>
      <div className="w-0 overflow-hidden py-1 transition-[width] duration-150 group-focus-within/volume:w-18 group-hover/volume:w-18 group-data-[open]/volume:w-18" data-testid="media-volume-slider">
        <Slider
          className="mx-1.5 w-15"
          value={[silent ? 0 : volume]}
          max={1}
          step={0.05}
          thumbLabel="Volume"
          trackClassName="data-[orientation=horizontal]:h-1 bg-cf-control-active"
          rangeClassName="bg-cf-text"
          thumbClassName="size-3 border-0 bg-cf-text shadow-none hover:ring-2 focus-visible:ring-2"
          onValueChange={([v]) => {
            setDragging(true);
            if (v !== undefined) setVolume(v);
          }}
          onValueCommit={() => {
            setDragging(false);
          }}
        />
      </div>
    </div>
  );
}
