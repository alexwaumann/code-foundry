import type { ReactNode } from "react";
import type { FlameState } from "@/lib/ember";
import { cn } from "@/lib/utils";
import "./ember.css";

/** Where the flame sits: the pinned sidebar row (28×32), the chat header (18×20), the settings nav (14×16), an empty state (64×72). */
export type FlameSize = "row" | "header" | "nav" | "hero";

const STATE_LABELS: Readonly<Record<FlameState, string>> = {
  idle: "Idle",
  thinking: "Thinking",
  working: "Workers running",
  attention: "Has something for you",
};

/** The mouth per state: a smile, a small "o" while thinking, a flat concentrating line while working, an open grin for attention. */
const MOUTH: Readonly<Record<FlameState, ReactNode>> = {
  idle: <path className="mouth" strokeWidth="1.1" d="M13.8 27.5q2.2 1.8 4.4 0" />,
  thinking: <circle className="mouth" strokeWidth="1" cx="16" cy="28" r="1" />,
  working: <path className="mouth" strokeWidth="1.1" d="M14.4 27.8q1.6 .8 3.2 0" />,
  attention: <path className="mouthfill" d="M13 27q3 3.8 6 0z" />,
};

/** The gradient ids are document-global; every flame defines the same two, which is harmless. */
const OUTER_GRADIENT = "cf-flame-outer-fill";
const INNER_GRADIENT = "cf-flame-inner-fill";

/**
 * Ember's glyph (docs/notes/ember-flame-c.md): a chubby flame with a gradient body and a
 * cream core, big eyes with catch-lights, eyebrows and a mouth, all acting by state
 * (ember.css): idle wobbles slowly with the eyes drifting around, thinking stands taller
 * with the eyes up and one brow raised, working flickers with sparks and the brows pulled
 * in, attention bounces with wide eyes, an open grin and an amber ring. Hovering winks.
 * It animates regardless of the system's Reduce Motion (a mascot's idle motion, not an
 * interaction animation). Decorative unless `label` is set.
 */
export function Flame({ state, size, label, className }: { state: FlameState; size: FlameSize; label?: string; className?: string }) {
  return (
    <span
      className={cn("cf-flame", className)}
      data-size={size}
      data-state={state}
      data-testid="ember-flame"
      role={label ? "img" : undefined}
      aria-label={label ? `${label}: ${STATE_LABELS[state]}` : undefined}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox="0 -2 32 36">
        <defs>
          <linearGradient id={OUTER_GRADIENT} x1="0" y1="0" x2="0" y2="1">
            <stop className="stop-tip" offset="0" />
            <stop className="stop-mid" offset=".55" />
            <stop className="stop-base" offset="1" />
          </linearGradient>
          <linearGradient id={INNER_GRADIENT} x1="0" y1="0" x2="0" y2="1">
            <stop className="stop-core-top" offset="0" />
            <stop className="stop-core-bottom" offset="1" />
          </linearGradient>
        </defs>
        <g className="glow">
          <path
            className="body outer"
            fill={`url(#${OUTER_GRADIENT})`}
            d="M16 1.5C14.5 7 5 11 5 22A11 11 0 0 0 27 22C27 16 23.5 12.5 21.5 9.5C21 12 19.5 13.5 18.2 14C18.8 9.5 18 5 16 1.5Z"
          />
          <path
            className="body inner"
            fill={`url(#${INNER_GRADIENT})`}
            d="M16 11C15 15.5 10 18 10 24A6 6 0 0 0 22 24C22 20 19.5 18 18.3 16C18 17.8 17.3 18.6 16.6 18.9C17 16.5 16.9 13.5 16 11Z"
          />
        </g>
        <g className="sparks">
          <circle className="spark" cx="11.5" cy="5" r=".9" />
          <circle className="spark" cx="20.5" cy="3.5" r=".8" />
          <circle className="spark" cx="16" cy="-.5" r=".7" />
        </g>
        <g className="eyes">
          <g className="eye-left">
            <ellipse className="eye" cx="12.4" cy="23.4" rx="2.55" ry="2.95" />
          </g>
          <g className="eye-right">
            <ellipse className="eye" cx="19.6" cy="23.4" rx="2.55" ry="2.95" />
          </g>
          <g className="pupils">
            <circle className="pupil" cx="12.7" cy="23.9" r="1.5" />
            <circle className="pupil" cx="19.9" cy="23.9" r="1.5" />
            <circle className="catchlight" cx="13.3" cy="23" r=".6" />
            <circle className="catchlight" cx="20.5" cy="23" r=".6" />
          </g>
        </g>
        <path className="brow brow-left" d="M9.9 19.4q2.3-1.3 4.6-.4" />
        <path className="brow brow-right" d="M17.5 19q2.3-.9 4.6 .4" />
        {MOUTH[state]}
      </svg>
    </span>
  );
}

/** The settings nav's icon for the Ember page: the flame, idle, at 14×16 (a LucideIcon's place). */
export function FlameNavIcon({ className }: { className?: string }) {
  return <Flame state="idle" size="nav" className={className} />;
}
