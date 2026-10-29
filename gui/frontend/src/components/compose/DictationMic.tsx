import { useEffect, useRef, useState } from "react";
import { Loader2, Mic } from "lucide-react";
import { openExternal } from "@/api/app";
import { Tip } from "@/components/ui/tooltip";
import { formatChord } from "@/keys/chord";
import { barHeight, decayLevels, formatElapsed, LEVEL_BARS, LEVEL_GAP_MS, MIC_SETTINGS_URL, pushLevel } from "@/lib/dictation";
import { cn } from "@/lib/utils";
import { useCommandsStore } from "@/stores/commands";
import { onDictationLevel, stopDictationIn, toggleDictation, useDictationStore } from "@/stores/dictation";
import type { ComposerDictation } from "./useComposerDictation";
import "./dictation.css";

/** The session's elapsed time, ticking while it listens. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => {
      clearInterval(t);
    };
  }, []);
  return <span className="tabular-nums">{formatElapsed(since > 0 ? now - since : 0)}</span>;
}

/** Seven live level bars: levels push in from the right and fall back when they stop (lib/dictation), drawn without React renders. */
function LevelBars() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let bars: number[] = new Array<number>(LEVEL_BARS).fill(0);
    let last = performance.now();
    // Levels arrive about every 50 ms; the bars fall back only once they stop (a pause, the end).
    let lastLevel = 0;
    let frame = 0;
    const draw = () => {
      const el = ref.current;
      if (!el) return;
      bars.forEach((v, i) => {
        const bar = el.children[i] as HTMLElement | undefined;
        if (bar) bar.style.height = `${String(barHeight(v))}px`;
      });
    };
    const tick = (t: number) => {
      if (t - lastLevel > LEVEL_GAP_MS) bars = decayLevels(bars, t - last);
      last = t;
      draw();
      frame = requestAnimationFrame(tick);
    };
    const off = onDictationLevel((rms) => {
      bars = pushLevel(bars, rms);
      lastLevel = performance.now();
      draw();
    });
    frame = requestAnimationFrame(tick);
    return () => {
      off();
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <span ref={ref} className="cf-dict-bars" aria-hidden data-testid="dictation-bars">
      {Array.from({ length: LEVEL_BARS }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

const MIC_CLASS =
  "flex size-7 items-center justify-center rounded-md text-cf-text-muted outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 disabled:pointer-events-none disabled:opacity-50";
const PILL_CLASS = "cf-dict-pill inline-flex h-7 shrink-0 items-center gap-2 rounded-full pr-2.5 pl-[9px] text-body-sm outline-none focus-visible:ring-[3px] focus-visible:ring-cf-focus/50";

/**
 * The composer's mic, beside its attach button: the idle mic (tooltip "Dictate ⌘⇧M"), the
 * listening pill (pulsing dot, live levels, elapsed m:ss; a click stops), "Loading model…"
 * while a Start waits for the model, or the mic disabled with the engine's failure in its
 * tooltip. Nothing while dictation is off or has no model. `stop`: data-compose-stop for
 * the new-thread composer's Tab order.
 */
export function DictationMic({ dictation, disabled = false, className, stop = false }: { dictation: ComposerDictation; disabled?: boolean; className?: string; stop?: boolean }) {
  const { clientId, availability, phase } = dictation;
  const loading = useDictationStore((s) => phase === "starting" && (s.snapshot?.state === "loading" || s.snapshot?.state === "unloaded"));
  const startedAt = useDictationStore((s) => (phase && s.active?.clientId === clientId ? s.active.startedAtMs : 0));
  const error = useDictationStore((s) => (availability === "error" ? s.snapshot?.error || "the engine failed" : ""));
  const chord = useCommandsStore((s) => s.commands.find((c) => c.name === "dictation.toggle")?.keybindings[0] ?? "");
  const stopAttrs = stop ? { "data-compose-stop": "" } : {};
  if (availability === "hidden" && !phase) return null;

  if (phase && loading) {
    return (
      <button
        type="button"
        className={cn(PILL_CLASS, "loading", className)}
        aria-label="Loading model… (stop dictating)"
        data-testid="dictation-loading"
        onClick={() => {
          toggleDictation(clientId);
        }}
        {...stopAttrs}
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Loading model…
      </button>
    );
  }
  if (phase) {
    return (
      <button
        type="button"
        className={cn(PILL_CLASS, phase === "stopping" && "opacity-70", className)}
        aria-label="Stop dictating"
        data-testid="dictation-pill"
        data-phase={phase}
        // The caret stays in the prompt (typing while listening goes on there).
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => {
          stopDictationIn(clientId);
        }}
        {...stopAttrs}
      >
        <span className="cf-dict-dot" aria-hidden />
        <LevelBars />
        <Elapsed since={startedAt} />
      </button>
    );
  }
  const failed = availability === "error";
  const label = failed ? `Dictation failed: ${error}. Turn it off and on in Settings to retry.` : `Dictate${chord ? ` ${formatChord(chord)}` : ""}`;
  return (
    // The span carries the tooltip while the button is disabled (no pointer events).
    <Tip label={label}>
      <span className={cn("flex", className)}>
        <button
          type="button"
          disabled={disabled || failed}
          aria-label={failed ? label : "Dictate"}
          data-testid="dictation-mic"
          data-state={failed ? "error" : "idle"}
          className={cn(MIC_CLASS, failed && "text-cf-error-text")}
          // The caret stays in the prompt: phrases land where it was.
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            toggleDictation(clientId);
          }}
          {...stopAttrs}
        >
          <Mic className="size-4" aria-hidden />
        </button>
      </span>
    </Tip>
  );
}

/**
 * The line under a composer's chip row: macOS denied the microphone (with the link to
 * System Settings), or why its last Start failed. Only under the composer that pressed.
 */
export function DictationNote({ dictation, className }: { dictation: ComposerDictation; className?: string }) {
  const { clientId } = dictation;
  const denied = useDictationStore((s) => s.snapshot?.micDenied === true && s.snapshot.enabled && s.lastClientId === clientId);
  const failure = useDictationStore((s) => (s.failure?.clientId === clientId ? s.failure.message : ""));
  if (denied) {
    return (
      <p className={cn("text-caption", className)} role="status" data-testid="dictation-denied">
        Code Foundry can't use the microphone.{" "}
        <button type="button" className="text-link underline" onClick={() => void openExternal(MIC_SETTINGS_URL).catch(() => undefined)} data-testid="dictation-denied-link">
          Allow it in System Settings → Privacy & Security → Microphone
        </button>
        , then try again.
      </p>
    );
  }
  if (failure) {
    return (
      <p className={cn("text-caption text-cf-error-text", className)} role="alert" data-testid="dictation-failure">
        Dictation didn't start: {failure}
      </p>
    );
  }
  return null;
}
