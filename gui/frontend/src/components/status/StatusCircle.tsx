import { CircleDashed, type LucideProps } from "lucide-react";
import { forwardRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The app's one mark for "a thread or check is working or waiting" (docs/notes/working-circle.md):
 * a dashed circle that turns slowly. Working turns once in 5 s in the info tone; waiting once in
 * 11 s, muted. Nothing else moves: the box is the icon's own and only `transform` rotates
 * (index.css --animate-status-*). It turns under prefers-reduced-motion too: the turn says
 * something is running, it is not a transition, so it is not gated (like the arrival tilt).
 *
 * Every circle keeps the page clock's phase (a negative animation-delay taken when it mounts), so
 * one that mounts again (a virtualized sidebar row scrolled back, the live turn header settling)
 * carries on from where it was instead of jumping back to the top, and all of a tone turn as one.
 *
 * The tone sets the colour; a colour class in `className` replaces it (the sidebar's muted).
 */

export type StatusCircleTone = "working" | "waiting";

const motion: Readonly<Record<StatusCircleTone, string>> = {
  working: "animate-status-working",
  waiting: "animate-status-waiting",
};

/** One turn, in ms: index.css --animate-status-working and --animate-status-waiting. */
const STATUS_CIRCLE_PERIOD_MS: Readonly<Record<StatusCircleTone, number>> = {
  working: 5000,
  waiting: 11_000,
};

/** The delay that puts a circle mounting at `nowMs` (page time) in phase with every other of its tone. */
function statusCirclePhase(tone: StatusCircleTone, nowMs: number): string {
  return `-${String(Math.floor(nowMs % STATUS_CIRCLE_PERIOD_MS[tone]))}ms`;
}

const colour: Readonly<Record<StatusCircleTone, string>> = {
  working: "text-cf-info-text",
  waiting: "text-cf-text-muted",
};

export interface StatusCircleProps extends Omit<LucideProps, "ref"> {
  tone: StatusCircleTone;
}

export const StatusCircle = forwardRef<SVGSVGElement, StatusCircleProps>(function StatusCircle({ tone, className, style, ...props }, ref) {
  const [mountedAt] = useState(() => performance.now());
  return (
    <CircleDashed
      ref={ref}
      data-status-circle={tone}
      className={cn(colour[tone], motion[tone], className)}
      style={{ animationDelay: statusCirclePhase(tone, mountedAt), ...style }}
      {...props}
    />
  );
});

/*
 * The circle as a lucide icon for a table of icons (lib/statusRegistry, the pull request
 * readiness cards): same props as one, and it takes its colour from the text around it
 * (currentColor) as the icon it replaces did, so the table's tone still applies; a colour in
 * className still wins.
 */

/** The working circle as an icon, in the surrounding text's colour. */
export const WorkingCircle = forwardRef<SVGSVGElement, Omit<LucideProps, "ref">>(function WorkingCircle({ className, ...props }, ref) {
  return <StatusCircle ref={ref} tone="working" className={cn("text-current", className)} {...props} />;
});

/** The waiting circle as an icon, in the surrounding text's colour. */
export const WaitingCircle = forwardRef<SVGSVGElement, Omit<LucideProps, "ref">>(function WaitingCircle({ className, ...props }, ref) {
  return <StatusCircle ref={ref} tone="waiting" className={cn("text-current", className)} {...props} />;
});
