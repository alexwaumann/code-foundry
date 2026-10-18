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
  muted: "text-muted-foreground",
  attention: "text-warning",
  error: "text-destructive",
  ok: "",
};

/** A pill's tint per tone (MCP's PILL). */
export const tonePill: Record<Tone, string> = {
  "": "bg-muted text-muted-foreground",
  muted: "bg-muted text-muted-foreground",
  attention: "bg-warning/15 text-warning",
  error: "bg-destructive/15 text-destructive",
  ok: "bg-success/15 text-success",
};

/** A card's or notice's border per tone. */
export const toneBorder: Record<Tone, string> = {
  "": "border-border",
  muted: "border-border",
  attention: "border-warning/35",
  error: "border-destructive/35",
  ok: "border-border",
};

/** A status as a dot (rows): emerald, red, amber, muted; running and the rest are drawn otherwise (dotFor). */
export const statusDot: Record<Status, string> = {
  "": "bg-muted-foreground/40",
  ok: "bg-success",
  failed: "bg-destructive",
  attention: "bg-warning",
  running: "",
  pending: "border-[1.5px] border-muted-foreground/50",
  skipped: "border-[1.5px] border-muted-foreground/50",
  off: "bg-muted-foreground/40",
};

/** A status as an icon (chips, step lists) with its colour. */
export const statusIcon: Record<Status, { icon: LucideIcon; className: string }> = {
  "": { icon: CircleDashed, className: "text-muted-foreground" },
  ok: { icon: CircleCheck, className: "text-success" },
  failed: { icon: CircleX, className: "text-destructive" },
  attention: { icon: TriangleAlert, className: "text-warning" },
  running: { icon: LoaderCircle, className: "animate-spin text-muted-foreground motion-reduce:animate-none" },
  pending: { icon: CircleDashed, className: "text-muted-foreground" },
  skipped: { icon: CircleSlash, className: "text-muted-foreground" },
  off: { icon: Ban, className: "text-muted-foreground" },
};

/** Tone of the word a status reads as (a chip's border and label). */
export function statusTone(s: Status | undefined): Tone {
  return s === "failed" ? "error" : s === "attention" ? "attention" : "";
}
