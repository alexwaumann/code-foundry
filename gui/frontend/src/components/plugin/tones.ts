/**
 * Tone and status → class tables for plugin views (PRIMITIVES.md §A "Shared value
 * types"). Amber is "needs you", red an error; emerald (`ok`) only in pills and status
 * glyphs, as the MCP cards and PR checks do. Theme status tokens, so both schemes follow.
 */
import { Ban, CircleCheck, CircleDashed, CircleSlash, CircleX, LoaderCircle, TriangleAlert, type LucideIcon } from "lucide-react";
import type { Status, Tone } from "@/api/plugin";

/** Text colour per tone; `ok` reads neutral on text. */
export const toneText: Record<Tone, string> = {
  "": "",
  muted: "text-cf-text-muted",
  attention: "text-cf-warning",
  error: "text-cf-error",
  ok: "",
};

/** A pill's tint per tone (MCP's PILL). */
export const tonePill: Record<Tone, string> = {
  "": "bg-cf-surface-sunken text-cf-text-muted",
  muted: "bg-cf-surface-sunken text-cf-text-muted",
  attention: "bg-cf-warning-surface text-cf-warning",
  error: "bg-cf-error-surface text-cf-error",
  ok: "bg-cf-success-surface text-cf-success",
};

/** A card's or notice's border per tone. */
export const toneBorder: Record<Tone, string> = {
  "": "border-cf-border",
  muted: "border-cf-border",
  attention: "border-cf-warning/35",
  error: "border-cf-error/35",
  ok: "border-cf-border",
};

/**
 * A status as a dot (rows): emerald, red, amber, muted; pending a hollow ring. Running (a
 * spinner) and skipped (a dash, so it never reads as pending) are drawn by GlyphView.
 */
export const statusDot: Record<Status, string> = {
  "": "bg-cf-text-muted/40",
  ok: "bg-cf-success",
  failed: "bg-cf-error",
  attention: "bg-cf-warning",
  running: "",
  pending: "border-[1.5px] border-cf-text-muted/60",
  skipped: "",
  off: "bg-cf-text-muted/40",
};

/** A status as an icon (chips, step lists) with its colour. */
export const statusIcon: Record<Status, { icon: LucideIcon; className: string }> = {
  "": { icon: CircleDashed, className: "text-cf-text-muted" },
  ok: { icon: CircleCheck, className: "text-cf-success" },
  failed: { icon: CircleX, className: "text-cf-error" },
  attention: { icon: TriangleAlert, className: "text-cf-warning" },
  running: { icon: LoaderCircle, className: "animate-spin text-cf-text-muted motion-reduce:animate-none" },
  pending: { icon: CircleDashed, className: "text-cf-text-muted" },
  skipped: { icon: CircleSlash, className: "text-cf-text-muted" },
  off: { icon: Ban, className: "text-cf-text-muted" },
};

/** Tone of the word a status reads as (a chip's border and label). */
export function statusTone(s: Status | undefined): Tone {
  return s === "failed" ? "error" : s === "attention" ? "attention" : "";
}
