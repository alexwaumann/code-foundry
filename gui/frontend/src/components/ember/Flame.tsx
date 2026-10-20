import type { FlameState } from "@/lib/ember";
import { cn } from "@/lib/utils";
import "./ember.css";

/** Where the flame sits: the pinned sidebar row (22×25), the chat header (16×18), the settings nav (13×15), an empty state (44×50). */
export type FlameSize = "row" | "header" | "nav" | "hero";

/** The mouth: a small smile, a grin when Ember has something for the user. */
const SMILE = "M10.2 18.3q1.8 1.3 3.6 0";
const GRIN = "M9.6 17.6q2.4 2.2 4.8 0";

const STATE_LABELS: Readonly<Record<FlameState, string>> = {
  idle: "Idle",
  thinking: "Thinking",
  working: "Workers running",
  attention: "Has something for you",
};

/**
 * Ember's glyph (docs/notes/ember-3-gui.md, the approved sketch): a flame with eyes and a
 * mouth, its motion by state (ember.css): idle wobbles slowly and dim, thinking stands
 * taller with the eyes up, working flickers, attention grins inside an amber ring. Static
 * under prefers-reduced-motion. Decorative unless `label` is set.
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
      <svg viewBox="0 0 24 26">
        <g className="glow">
          <path
            className="outer"
            fill="#ff7a2f"
            d="M12 1.2c-1.1 3.8-6.4 6.8-6.4 13.2A6.4 6.4 0 0 0 18.4 14.4c0-3.1-1.6-5.2-3.1-7.6-.4 1.7-1 2.9-2.3 3.5.5-2.8.2-5.8-1-9.1z"
          />
          <path className="inner" fill="#ffc94d" d="M12 10.2c-.9 2.1-3.4 3.4-3.4 6.4a3.4 3.4 0 0 0 6.8 0c0-1.9-1-3.1-1.7-4.6-.3.9-.7 1.5-1.4 1.7.2-1.2.1-2.4-.3-3.5z" />
        </g>
        <g className="eyes">
          <ellipse cx="9.9" cy="15.6" rx="1.45" ry="1.9" fill="#fff8e6" />
          <ellipse cx="14.1" cy="15.6" rx="1.45" ry="1.9" fill="#fff8e6" />
          <g className="pupils">
            <circle cx="10.1" cy="16" r=".8" fill="#2b1a0e" />
            <circle cx="14.3" cy="16" r=".8" fill="#2b1a0e" />
          </g>
        </g>
        <path d={state === "attention" ? GRIN : SMILE} fill="none" stroke="#2b1a0e" strokeWidth=".9" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/** The settings nav's icon for the Ember page: the flame, idle, at 13×15 (a LucideIcon's place). */
export function FlameNavIcon({ className }: { className?: string }) {
  return <Flame state="idle" size="nav" className={className} />;
}
