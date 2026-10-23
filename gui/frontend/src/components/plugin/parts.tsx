/**
 * The shared pieces of plugin views: inline content (text runs with tones, links and
 * ticking times), pills, status glyphs and buttons (PRIMITIVES.md §A, shared value types).
 */
import { Check, Circle, Copy, ExternalLink, LoaderCircle } from "lucide-react";
import type { Glyph as GlyphValue, Inline, Pill as PillValue, Span, ViewButton } from "@/api/plugin";
import { inlineSpans, inlineText } from "@/api/plugin";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { useCopied } from "@/lib/useCopied";
import { cn } from "@/lib/utils";
import { usePending } from "@/stores/pluginSurfaces";
import { openElementUrl } from "@/stores/pluginSurfaces";
import { useRunAction } from "./actions";
import { useFormCtx, useViewCtx } from "./context";
import { formatFixedDuration, formatTime } from "./format";
import { PLUGIN_ICONS } from "./icons";
import { statusDot, statusIcon, toneText, tonePill } from "./tones";

/** An allowlisted lucide icon by kebab name (a circle for any other name; `fallback` when there is none). */
export function PluginIcon({ name, fallback = "circle", className, label }: { name: string | undefined; fallback?: string; className?: string; label?: string }) {
  const Icon = (name ? PLUGIN_ICONS[name] : undefined) ?? PLUGIN_ICONS[name ? "circle" : fallback] ?? Circle;
  return <Icon className={className} aria-hidden={label ? undefined : true} aria-label={label} />;
}

/** A time span: its own component on the shared 1 s clock, so only it re-renders. */
function TimeText({ at, style }: { at: string; style: "relative" | "elapsed" | "countdown" | undefined }) {
  const now = useNow(1000);
  return <span className="tabular-nums">{formatTime(at, style, now)}</span>;
}

function SpanView({ span }: { span: Span }) {
  const body = span.time ? <TimeText at={span.time.at} style={span.time.style} /> : span.duration ? <span className="tabular-nums">{formatFixedDuration(span.duration.ms)}</span> : span.text;
  const cls = cn(toneText[span.tone ?? ""], span.mono && "font-mono", span.strong && "font-semibold");
  if (span.url) {
    const url = span.url;
    return (
      <Tip label={url}>
        <a
          href={url}
          className={cn("text-link", cls)}
          onClick={(e) => {
            e.preventDefault();
            openElementUrl(url);
          }}
        >
          {body}
        </a>
      </Tip>
    );
  }
  return cls ? <span className={cls}>{body}</span> : <>{body}</>;
}

/** Inline content: a bare string or spans. */
export function InlineView({ value, className }: { value: Inline | undefined; className?: string }) {
  const spans = inlineSpans(value);
  if (spans.length === 0) return null;
  return (
    <span className={className}>
      {spans.map((s, i) => (
        <SpanView key={i} span={s} />
      ))}
    </span>
  );
}

/** Inline content that truncates on one line, its full text in a tooltip when cut. */
export function InlineLine({ value, className }: { value: Inline | undefined; className?: string }) {
  if (inlineSpans(value).length === 0) return null;
  return (
    <Tip label={inlineText(value)} whenTruncated>
      <span className={cn("min-w-0 truncate", className)}>
        <InlineView value={value} />
      </span>
    </Tip>
  );
}

/** A small tinted label (MCP's pill); never shrinks. */
export function PillView({ pill, className }: { pill: PillValue | undefined; className?: string }) {
  if (!pill?.label) return null;
  return (
    <span className={cn("shrink-0 rounded-full px-1.5 text-caption-sm font-medium whitespace-nowrap", tonePill[pill.tone ?? ""], className)} data-testid="plugin-pill" data-tone={pill.tone || undefined}>
      {pill.label}
    </span>
  );
}

/** A status (dot or icon style) or an allowlisted icon with a tone. */
export function GlyphView({ glyph, style = "dot", className }: { glyph: GlyphValue | undefined; style?: "dot" | "icon"; className?: string }) {
  if (!glyph) return null;
  if (glyph.icon) {
    const tone = glyph.tone ?? "";
    return <PluginIcon name={glyph.icon} className={cn("size-3.5 shrink-0", tone === "ok" ? "text-cf-success-text" : tone ? toneText[tone] : "text-cf-text-muted", className)} />;
  }
  const status = glyph.status ?? "";
  if (style === "icon" || status === "running") {
    const { icon: Icon, className: c } = statusIcon[status];
    return <Icon className={cn("size-3.5 shrink-0", c, className)} aria-label={status || undefined} data-status={status} />;
  }
  if (status === "skipped") {
    // A dash, not a ring: pending is the hollow ring.
    return (
      <span className={cn("flex size-2 shrink-0 items-center justify-center", className)} role="img" aria-label="skipped" data-status={status}>
        <span className="h-0.5 w-2 rounded-full bg-cf-text-muted/70" />
      </span>
    );
  }
  return <span className={cn("size-2 shrink-0 rounded-full", statusDot[status], className)} role="img" aria-label={status || "status"} data-status={status} />;
}

/** Each style's classes on the shadcn button (no filled style: DECISIONS.md rule 7). */
const buttonStyle: Record<NonNullable<ViewButton["style"]>, string> = {
  muted: "text-cf-text-muted hover:text-cf-text",
  outline: "border border-cf-border text-cf-text",
  attention: "border border-cf-warning/40 text-cf-warning-text hover:bg-cf-warning-surface hover:text-cf-warning-text dark:hover:bg-cf-warning-surface",
  destructive: "text-cf-text-muted hover:bg-cf-error-surface hover:text-cf-error-text focus-visible:text-cf-error-text dark:hover:bg-cf-error-surface",
  link: "h-auto px-0 text-link hover:bg-transparent hover:underline has-[>svg]:px-0 dark:hover:bg-transparent",
};

/**
 * A plugin's button: muted unless the plugin picks outline, attention (amber outline: the
 * one thing that needs the user next), destructive (red only on hover; the command's
 * confirm dialog carries the weight) or link. Pending from the click until the plugin
 * answers (or the command returns), `busy` while the plugin says so. An icon-only button
 * gets its label as a tooltip (the only one: the label is otherwise hidden).
 */
export function PluginButton({ button, values, onClick, submit }: { button: ViewButton; values?: () => Readonly<Record<string, string | boolean | string[]>>; onClick?: () => void; submit?: boolean }) {
  const { watchKey, inert } = useViewCtx();
  const form = useFormCtx();
  const run = useRunAction();
  const pending = usePending(watchKey, button.key) || (button.busy ?? false);
  const style = button.style ?? "muted";
  const icon = pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : button.icon ? <PluginIcon name={button.icon} /> : null;
  const disabled = (button.disabled ?? false) || pending || inert || (form?.locked ?? false);
  const external = button.action?.openUrl && style === "link" && !button.iconOnly;
  const click = () => {
    if (onClick) onClick();
    else run(button.key, button.action, values?.());
  };
  const el = (
    <Button
      type={submit ? "submit" : "button"}
      variant={style === "outline" ? "outline" : "ghost"}
      size={button.iconOnly ? "icon-xs" : "xs"}
      className={cn(buttonStyle[style], style === "outline" && "bg-transparent dark:bg-transparent", !button.iconOnly && "max-w-full min-w-0")}
      disabled={disabled}
      aria-label={button.iconOnly ? button.label : undefined}
      aria-busy={pending || undefined}
      data-testid="plugin-button"
      data-key={button.key}
      data-style={style}
      onClick={submit ? undefined : click}
    >
      {icon}
      {!button.iconOnly && <span className="min-w-0 truncate">{button.label}</span>}
      {external && <ExternalLink className="size-3" aria-hidden />}
    </Button>
  );
  // A label wider than the panel truncates; the tooltip then shows it whole.
  if (!button.iconOnly) {
    return (
      <Tip label={button.label} whenTruncated>
        {el}
      </Tip>
    );
  }
  // The span carries the tooltip while the button is disabled (no pointer events).
  return (
    <Tip label={button.label}>
      <span className="inline-flex shrink-0">{el}</span>
    </Tip>
  );
}

/** A row of buttons that wraps; a button shrinks only when its label alone is wider than the row (it truncates). */
export function ButtonBar({ buttons, align, className }: { buttons: readonly ViewButton[] | undefined; align?: "start" | "end"; className?: string }) {
  if (!buttons || buttons.length === 0) return null;
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-1.5", align === "end" && "justify-end", className)}>
      {buttons.map((b) => (
        <PluginButton key={b.key} button={b} />
      ))}
    </div>
  );
}

/**
 * A muted Copy icon button (always visible): copies `text` on the host and shows a check
 * for a moment, no toast (an icon button's feedback is its check; a plugin's other copy
 * actions toast through copyElementText).
 */
export function CopyIconButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const { copied, copy } = useCopied();
  return (
    <Tip label={copied ? "Copied" : label}>
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-cf-text-muted hover:text-cf-text"
        aria-label={copied ? "Copied" : label}
        data-copied={copied || undefined}
        data-testid="plugin-copy"
        onClick={() => {
          void copy(text);
        }}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </Tip>
  );
}
