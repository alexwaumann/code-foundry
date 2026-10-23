import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { alphaOf, fromOklch, oklchRgb, parseHex, toHex, toOklch } from "@/themes/color";
import { CHECKER } from "./Swatch";

/** The plane's chroma axis: 0 to about the most any sRGB colour reaches. */
const C_MAX = 0.37;
/** The plane and the strips are drawn at this many pixels and stretched (they are smooth). */
const PLANE_W = 180;
const PLANE_H = 90;
const STRIP_W = 240;

interface Lch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** `#rrggbb` from OKLCH, with `#rrggbbaa`'s alpha appended when alpha < 1. */
function hexOf({ l, c, h }: Lch, alpha: number): string {
  const hex = fromOklch(l, c, h);
  return alpha < 1 ? hex + Math.round(clamp(alpha, 0, 1) * 255).toString(16).padStart(2, "0") : hex;
}

/** Paints RGBA pixels (0..1 floats, alpha 0 for none) into a canvas. */
function paint(canvas: HTMLCanvasElement | null, w: number, h: number, px: (x: number, y: number) => readonly [number, number, number, number]): void {
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;
  canvas.width = w;
  canvas.height = h;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = px(x, y);
      const i = (y * w + x) * 4;
      img.data[i] = r * 255;
      img.data[i + 1] = g * 255;
      img.data[i + 2] = b * 255;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * The theme editor's colour picker (sketch E): a lightness × chroma plane at the current
 * hue (OKLCH; pixels outside sRGB left empty), a hue strip, an alpha strip for tints
 * (`#rrggbbaa`), and hex, L, C, H (and A) fields. Arrow keys nudge the focused field or
 * the plane (Shift: ten times); Escape calls onEscape. Every change calls onChange with
 * the new hex; the hue survives a grey (chroma 0) because it is kept here.
 */
export function ColourPicker({ value, onChange, onEscape, label, tint }: { value: string; onChange: (hex: string) => void; onEscape?: () => void; label: string; tint?: boolean }) {
  const [lch, setLch] = useState<Lch>(() => {
    const [l, c, h] = toOklch(value);
    return { l, c, h };
  });
  const alpha = alphaOf(value);
  const emitted = useRef(value);
  // A value from outside (another field, Revert, a base change): take its OKLCH, keeping the hue of a grey.
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    const [l, c, h] = toOklch(value);
    setLch((cur) => ({ l, c, h: c < 0.002 ? cur.h : h }));
  }, [value]);

  const emit = (next: Lch, a = alpha) => {
    setLch(next);
    const hex = hexOf(next, a);
    emitted.current = hex;
    onChange(hex);
  };

  const plane = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    paint(plane.current, PLANE_W, PLANE_H, (x, y) => {
      const rgb = oklchRgb(1 - y / (PLANE_H - 1), (x / (PLANE_W - 1)) * C_MAX, lch.h);
      return rgb ? [rgb[0], rgb[1], rgb[2], 1] : [0, 0, 0, 0];
    });
  }, [lch.h]);
  const hueStrip = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    paint(hueStrip.current, STRIP_W, 1, (x) => {
      const rgb = parseHex(fromOklch(clamp(lch.l, 0.6, 0.8), Math.max(lch.c, 0.14), (x / (STRIP_W - 1)) * 360)).rgb;
      return [rgb[0], rgb[1], rgb[2], 1];
    });
  }, [lch.l, lch.c]);
  const alphaStrip = useRef<HTMLCanvasElement>(null);
  const opaque = toHex(parseHex(value).rgb);
  useEffect(() => {
    if (!tint) return;
    const rgb = parseHex(opaque).rgb;
    paint(alphaStrip.current, STRIP_W, 1, (x) => [rgb[0], rgb[1], rgb[2], x / (STRIP_W - 1)]);
  }, [tint, opaque]);

  const fromPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / r.width, 0, 1);
    const y = clamp((e.clientY - r.top) / r.height, 0, 1);
    emit({ l: 1 - y, c: x * C_MAX, h: lch.h });
  };

  const planeKeys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const k = e.shiftKey ? 10 : 1;
    const step: Record<string, Partial<Lch>> = { ArrowUp: { l: lch.l + 0.01 * k }, ArrowDown: { l: lch.l - 0.01 * k }, ArrowRight: { c: lch.c + 0.005 * k }, ArrowLeft: { c: lch.c - 0.005 * k } };
    const s = step[e.key];
    if (!s) {
      if (e.key === "Escape" && onEscape) {
        e.preventDefault();
        onEscape();
      }
      return;
    }
    e.preventDefault();
    emit({ l: clamp(s.l ?? lch.l, 0, 1), c: clamp(s.c ?? lch.c, 0, C_MAX), h: lch.h });
  };

  return (
    <div className="space-y-2.5" data-testid="colour-picker">
      <div
        role="slider"
        tabIndex={0}
        aria-label={`${label}: lightness and chroma`}
        aria-valuetext={`lightness ${String(Math.round(lch.l * 100))}, chroma ${lch.c.toFixed(3)}`}
        aria-valuenow={Math.round(lch.l * 100)}
        className="relative h-32 cursor-crosshair touch-none overflow-hidden rounded-md border border-cf-border bg-cf-surface-sunken outline-none focus-visible:ring-[3px] focus-visible:ring-cf-focus/50"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e);
        }}
        onKeyDown={planeKeys}
        data-testid="colour-plane"
      >
        <canvas ref={plane} className="pointer-events-none absolute inset-0 size-full" aria-hidden />
        <span
          className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-cf-surface ring-1 ring-cf-text"
          style={{ left: `${String((clamp(lch.c, 0, C_MAX) / C_MAX) * 100)}%`, top: `${String((1 - lch.l) * 100)}%` }}
          aria-hidden
        />
      </div>
      <Strip label={`${label}: hue`} value={lch.h} max={360} step={1} onChange={(h) => { emit({ ...lch, h }); }} onEscape={onEscape} testId="colour-hue">
        <canvas ref={hueStrip} className="absolute inset-0 size-full" aria-hidden />
      </Strip>
      {tint && (
        <Strip label={`${label}: alpha`} value={Math.round(alpha * 100)} max={100} step={1} onChange={(a) => { emit(lch, a / 100); }} onEscape={onEscape} testId="colour-alpha" checker>
          <canvas ref={alphaStrip} className="absolute inset-0 size-full" aria-hidden />
        </Strip>
      )}
      <div className="flex gap-1.5">
        <HexField value={value} tint={tint} onCommit={onChange} onNudge={(d) => { emit({ ...lch, l: clamp(lch.l + d, 0, 1) }); }} onEscape={onEscape} label={label} />
        <NumField label="L" name={`${label} lightness`} value={lch.l * 100} digits={0} step={1} min={0} max={100} onCommit={(v) => { emit({ ...lch, l: v / 100 }); }} onEscape={onEscape} />
        <NumField label="C" name={`${label} chroma`} value={lch.c} digits={3} step={0.005} min={0} max={C_MAX} onCommit={(v) => { emit({ ...lch, c: v }); }} onEscape={onEscape} />
        <NumField label="H" name={`${label} hue`} value={lch.h} digits={0} step={1} min={0} max={360} onCommit={(v) => { emit({ ...lch, h: v }); }} onEscape={onEscape} />
        {tint && <NumField label="A" name={`${label} alpha`} value={alpha * 100} digits={0} step={1} min={0} max={100} onCommit={(v) => { emit(lch, v / 100); }} onEscape={onEscape} />}
      </div>
    </div>
  );
}

/** A strip (hue, alpha): the shadcn Slider over a drawn gradient, its track transparent. */
function Strip({ label, value, max, step, onChange, onEscape, testId, checker, children }: { label: string; value: number; max: number; step: number; onChange: (v: number) => void; onEscape?: () => void; testId: string; checker?: boolean; children: ReactNode }) {
  return (
    <div className="relative flex h-4 items-center">
      <div className={cn("absolute inset-x-0 top-0.5 h-3 overflow-hidden rounded-full border border-cf-border", checker && CHECKER)}>{children}</div>
      <Slider
        value={[value]}
        min={0}
        max={max}
        step={step}
        thumbLabel={label}
        onValueChange={(v) => {
          const x = v[0];
          if (x !== undefined) onChange(x);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && onEscape) {
            e.preventDefault();
            onEscape();
          }
        }}
        trackClassName="bg-transparent data-[orientation=horizontal]:h-3"
        rangeClassName="bg-transparent"
        data-testid={testId}
      />
    </div>
  );
}

const fieldClass = "h-7 px-1.5 text-code";

/** Arrow-key nudges for a field: up/down by step (Shift: ten steps). */
function nudge(e: ReactKeyboardEvent<HTMLInputElement>, step: number, apply: (d: number) => void, onEscape?: () => void): boolean {
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    apply((e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
    return true;
  }
  if (e.key === "Escape" && onEscape) {
    e.preventDefault();
    e.currentTarget.blur();
    onEscape();
    return true;
  }
  return false;
}

/** The hex field: commits on Enter or blur when it is #rrggbb (or #rrggbbaa for a tint); arrows nudge the lightness. */
function HexField({ value, tint, onCommit, onNudge, onEscape, label }: { value: string; tint?: boolean; onCommit: (hex: string) => void; onNudge: (d: number) => void; onEscape?: () => void; label: string }) {
  // What is being typed; null shows the value.
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const t = text.trim().toLowerCase();
    const hex = t.startsWith("#") ? t : `#${t}`;
    setText(null);
    if ((/^#[0-9a-f]{6}$/.test(hex) || (tint && /^#[0-9a-f]{8}$/.test(hex))) && hex !== value) onCommit(hex);
  };
  return (
    <Input
      aria-label={`${label} hex`}
      value={text ?? value}
      spellCheck={false}
      className={cn(fieldClass, "w-24 shrink-0")}
      onBlur={commit}
      onChange={(e) => {
        setText(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          return;
        }
        if (nudge(e, 0.01, onNudge, onEscape)) setText(null);
      }}
      data-testid="colour-hex"
    />
  );
}

/** A number field (L, C, H, A): commits on Enter or blur, clamped; arrows step it at once. */
function NumField({ label, name, value, digits, step, min, max, onCommit, onEscape }: { label: string; name: string; value: number; digits: number; step: number; min: number; max: number; onCommit: (v: number) => void; onEscape?: () => void }) {
  const shown = digits === 0 ? String(Math.round(value)) : value.toFixed(digits).replace(/^0\./, ".");
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const v = Number(text);
    setText(null);
    if (Number.isFinite(v)) onCommit(clamp(v, min, max));
  };
  return (
    <label className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-cf-input px-1.5 focus-within:border-cf-focus">
      <span className="text-caption-sm" aria-hidden>
        {label}
      </span>
      <input
        aria-label={name}
        inputMode="decimal"
        className="h-7 w-full min-w-0 bg-transparent text-code outline-none"
        value={text ?? shown}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
            return;
          }
          if (nudge(e, step, (d) => { onCommit(clamp(value + d, min, max)); }, onEscape)) setText(null);
        }}
      />
    </label>
  );
}
