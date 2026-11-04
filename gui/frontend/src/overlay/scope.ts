/*!
 * The dictation overlay's dot scope: dimensions and constants from Hex
 * (https://github.com/anomalyco/hex), MIT, Copyright (c) 2026 Christopher Langton. The
 * full notice is in public/HEX-LICENSE.md, which ships in the app.
 */
import type { Rgb } from "@/themes/color";

/**
 * The simulation and drawing of the overlay's plate (docs/notes/dictate-anywhere-overlay.md).
 * A 43 x 9 field of dots shows two traces braided around each other; the voice's recent
 * history opens the braid from the middle out. The plate's width is a spring, every other
 * state an exponential toward its target, all stepped at a fixed 240 Hz so the look does
 * not depend on the display's refresh rate.
 */

/** Seconds per simulation step. */
export const SCOPE_STEP = 1 / 240;
/** The plate while listening, narrowing while working, and where it springs from; points. */
export const PLATE_WIDTH = 112;
export const WORKING_WIDTH = 76;
export const PLATE_HEIGHT = 26;
const START_WIDTH = 30;

const COLS = 43;
const ROWS = 9;
/** Dot spacing, points. */
const PITCH = 2.6;
/** The voice travels outward at this many points a second. */
const TRAVEL = 150;
const HISTORY = 512;
const TAU = Math.PI * 2;
const SPEEDS = [0.8, 1.25, 1.85, 2.6] as const;
const BASE = [0.55, 0.42, 0.3, 0.2] as const;
const SPATIAL = [1.4, 2.4, 3.8, 5.6] as const;
/** The spring: its period in seconds and damping ratio. */
const SPRING_PERIOD = 0.42;
const SPRING_DAMPING = 0.72;
/** How long done and failed hold before fading, seconds. */
const DONE_HOLD = 0.22;
const FAILED_HOLD = 0.55;
/** The middle-out clear on done, seconds. */
const WIPE = 0.3;
/** One pass of the light through a working plate, seconds. */
const FLOW_PERIOD = 0.55;
/** How far past the plate's half width the clear reaches, points. */
const WIPE_MARGIN = 6;

/**
 * What the plate is doing. "collapsing" is an end with nothing to report (a discarded press,
 * silence, dictation turned off): it shrinks and fades with no done look.
 */
export type ScopePhase = "listening" | "working" | "done" | "failed" | "collapsing";

export interface ScopeColours {
  plate: Rgb;
  edge: Rgb;
  /** The dots. */
  live: Rgb;
  /** The dots at the voice's peaks. */
  hot: Rgb;
  work: Rgb;
  err: Rgb;
}

/** A dot's column position from the plate's middle, points. */
const columnX = (c: number) => (c - (COLS - 1) / 2) * PITCH;
/** A dot's row position from the plate's middle, points. */
const rowY = (r: number) => (r - (ROWS - 1) / 2) * PITCH;

export class Scope {
  /** Each dot's brightness and how hot it is, 0..1, by column then row. */
  readonly dots = new Float32Array(COLS * ROWS);
  readonly heat = new Float32Array(COLS * ROWS);
  /** The plate's width, points. */
  width = START_WIDTH;
  /** 0 gone, 1 fully shown. */
  alpha = 0;
  /** How far the working look and the failed colour have come in, 0..1. */
  work = 0;
  err = 0;
  /** The clear's progress on done, 0..1. */
  wipe = 0;
  /** The smoothed input level, 0..1. */
  level = 0;
  phase: ScopePhase = "listening";

  private readonly history = new Float32Array(HISTORY);
  private head = 0;
  private t = 0;
  /** Seconds in this phase. */
  private phaseTime = 0;
  private velocity = 0;

  setPhase(phase: ScopePhase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    this.phaseTime = 0;
  }

  /** The plate has finished an end and faded out: nothing more to draw. */
  get gone(): boolean {
    return this.phase !== "listening" && this.phase !== "working" && this.alpha < 0.01;
  }

  private widthTarget(): number {
    switch (this.phase) {
      case "listening":
        return PLATE_WIDTH;
      case "working":
      case "failed":
        return WORKING_WIDTH;
      default:
        return START_WIDTH;
    }
  }

  private alphaTarget(): number {
    switch (this.phase) {
      case "done":
        return this.phaseTime > DONE_HOLD ? 0 : 1;
      case "failed":
        return this.phaseTime > FAILED_HOLD ? 0 : 1;
      case "collapsing":
        return 0;
      default:
        return 1;
    }
  }

  /** The level `ax` points from the middle: what the voice was when it left there. */
  private levelAt(ax: number): number {
    const back = Math.min(HISTORY - 1, Math.floor(ax / TRAVEL / SCOPE_STEP));
    return this.history[(this.head - back + HISTORY * 2) % HISTORY] ?? 0;
  }

  /** One SCOPE_STEP with `input` (0..1) as the voice's level now. */
  step(input: number): void {
    const dt = SCOPE_STEP;
    this.t += dt;
    this.phaseTime += dt;
    // A fast attack and a slower fall, so peaks land and pauses do not snap to nothing.
    this.level += (input - this.level) * (input > this.level ? 1 - Math.exp(-dt * TAU * 6.5) : 1 - Math.exp(-dt / 0.15));
    this.head = (this.head + 1) % HISTORY;
    this.history[this.head] = this.level;

    const p = this.phase;
    this.alpha += (this.alphaTarget() - this.alpha) * (1 - Math.exp(-dt / 0.07));
    this.work += ((p === "working" || p === "done" ? 1 : 0) - this.work) * (1 - Math.exp(-dt / 0.09));
    this.err += ((p === "failed" ? 1 : 0) - this.err) * (1 - Math.exp(-dt / 0.06));
    const k = (TAU / SPRING_PERIOD) ** 2;
    const c = 2 * SPRING_DAMPING * Math.sqrt(k);
    this.velocity += (k * (this.widthTarget() - this.width) - c * this.velocity) * dt;
    this.width += this.velocity * dt;
    this.wipe = p === "done" ? Math.min(1, this.phaseTime / WIPE) : 0;
    this.stepDots();
  }

  private stepDots(): void {
    const decay = Math.exp(-SCOPE_STEP / 0.3);
    const heatDecay = Math.exp(-SCOPE_STEP / 0.15);
    const wipeReach = this.wipe * (PLATE_WIDTH / 2 + WIPE_MARGIN);
    const pass = (this.phaseTime / FLOW_PERIOD) % 1;
    const rest = 1.5 + 0.5 * Math.sin((TAU * this.t) / 5.5) + this.work * 2.6;
    for (let col = 0; col < COLS; col++) {
      const x = columnX(col);
      const u = x / (PLATE_WIDTH / 2);
      const ax = Math.abs(x);
      const env = Math.cos((Math.min(1, Math.abs(u)) * Math.PI) / 2) ** 0.9;
      const amp = this.levelAt(ax);
      // Two traces braided around each other; the voice's history opens the braid.
      const turn = u * Math.PI * 1.6 + this.t * (2.2 + 3.4 * this.level);
      let wobble = 0;
      for (let i = 0; i < 4; i++) wobble += (BASE[i] ?? 0) * Math.sin((SPATIAL[i] ?? 0) * u * 2.4 - (SPEEDS[i] ?? 0) * this.t * 3.1 + i * 1.3);
      const a = (rest + amp * 15) * env;
      const trace1 = a * (0.72 * Math.sin(turn) + 0.34 * wobble);
      const trace2 = a * (0.72 * Math.sin(turn + Math.PI) - 0.34 * wobble);
      // The working light: a band that wraps through the plate.
      const span = 0.7;
      const v = x / WORKING_WIDTH - (pass - 0.5) * span;
      const wrapped = v - span * Math.round(v / span);
      const band = this.work > 0.02 ? Math.exp(-((wrapped / 0.15) ** 2)) : 0;
      const gain = (1 - this.work) * (0.42 + 0.58 * Math.min(1, amp * 2)) + this.work * (0.12 + 0.95 * band);
      for (let row = 0; row < ROWS; row++) {
        const y = rowY(row);
        const i = col * ROWS + row;
        const d = Math.min(Math.abs(y - trace1), Math.abs(y - trace2));
        const hit = Math.exp(-(d * d) / 4.6) * gain;
        this.dots[i] = Math.max((this.dots[i] ?? 0) * decay, hit);
        this.heat[i] = Math.max((this.heat[i] ?? 0) * heatDecay, hit * (0.25 + amp));
        if (ax < wipeReach) {
          this.dots[i] = 0;
          this.heat[i] = 0;
        }
      }
    }
  }
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c: Rgb) => `rgb(${String(c[0] | 0)},${String(c[1] | 0)},${String(c[2] | 0)})`;

/** Draws `scope` centred in a `width` x `height` point canvas of `scale` pixels a point. */
export function drawScope(ctx: CanvasRenderingContext2D, scope: Scope, col: ScopeColours, scale: number, width: number, height: number): void {
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (scope.alpha < 0.01) {
    ctx.restore();
    return;
  }
  const pop = 0.9 + 0.1 * scope.alpha;
  ctx.translate(width / 2, height / 2);
  ctx.scale(pop, pop);
  ctx.globalAlpha = scope.alpha;
  const w = scope.width;
  const radius = PLATE_HEIGHT / 2;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -PLATE_HEIGHT / 2, w, PLATE_HEIGHT, radius);
  ctx.shadowColor = "rgba(0,0,0,.28)";
  ctx.shadowBlur = 10 * scale;
  ctx.shadowOffsetY = 3 * scale;
  ctx.fillStyle = css(col.plate);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 1;
  ctx.strokeStyle = css(col.edge);
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(-w / 2 + 5, -PLATE_HEIGHT / 2 + 2, w - 10, PLATE_HEIGHT - 4, radius - 2);
  ctx.clip();
  const wipeReach = scope.wipe * (PLATE_WIDTH / 2 + WIPE_MARGIN);
  for (let c = 0; c < COLS; c++) {
    const x = columnX(c);
    const wiped = scope.wipe > 0 && Math.abs(x) < wipeReach;
    for (let r = 0; r < ROWS; r++) {
      const i = c * ROWS + r;
      const b = Math.min(1, scope.dots[i] ?? 0);
      let k = mix(col.live, col.hot, Math.min(1, (scope.heat[i] ?? 0) * 1.1));
      k = mix(k, col.work, scope.work);
      k = mix(k, col.err, scope.err);
      ctx.fillStyle = `rgba(${String(k[0] | 0)},${String(k[1] | 0)},${String(k[2] | 0)},${String((wiped ? 0 : 0.1) + 0.9 * b)})`;
      ctx.beginPath();
      ctx.arc(x, rowY(r), 0.72 + 0.32 * b, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
  ctx.restore();
}
