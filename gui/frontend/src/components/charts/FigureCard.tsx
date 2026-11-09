import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface FigureCardProps {
  label: ReactNode;
  figure: ReactNode;
  subtitle?: ReactNode;
  /** The figure's type role and tone (`text-display-sm text-cf-warning-text`). */
  figureClassName: string;
  /** A toggle's state; a card with `onPress` is a button. */
  pressed?: boolean;
  /** Another card of the row is pressed: this one dims until hovered. */
  dimmed?: boolean;
  /** Nothing to show: muted (and a disabled button). */
  empty?: boolean;
  onPress?: () => void;
  figureProps?: ComponentProps<"span"> & Record<`data-${string}`, unknown>;
  subtitleProps?: ComponentProps<"span"> & Record<`data-${string}`, unknown>;
}

/**
 * A figure card (the Pull Requests counts, plugin stats): a muted label, the figure, a
 * caption; label and caption cut with "…". With `onPress` it is a toggle button (a filter):
 * pressed it is ringed, and the other cards of its row dim while one is pressed.
 */
export function FigureCard({
  label,
  figure,
  subtitle,
  figureClassName,
  pressed = false,
  dimmed = false,
  empty = false,
  onPress,
  figureProps,
  subtitleProps,
  className,
  ...rest
}: FigureCardProps & Omit<ComponentProps<"button">, "children" | "onClick">) {
  const body = (
    <>
      <span className="w-full truncate text-label font-normal text-cf-text-muted">{label}</span>
      <span {...figureProps} className={cn("max-w-full truncate whitespace-nowrap", figureClassName, figureProps?.className)}>
        {figure}
      </span>
      {subtitle !== undefined && (
        <span {...subtitleProps} className={cn("w-full truncate text-caption", subtitleProps?.className)}>
          {subtitle}
        </span>
      )}
    </>
  );
  const box = "flex min-w-0 flex-col items-start rounded-lg border px-3.5 py-3 text-left";
  if (!onPress) {
    return (
      <div className={cn(box, empty && "opacity-60", className)} {...(rest as ComponentProps<"div">)}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      disabled={empty}
      aria-pressed={pressed}
      onClick={onPress}
      className={cn(
        box,
        "transition-[opacity,border-color] outline-none focus-visible:ring-1 focus-visible:ring-cf-focus",
        pressed ? "border-cf-text ring-1 ring-cf-text" : "enabled:hover:border-cf-border-strong",
        dimmed && !pressed && "opacity-50 enabled:hover:opacity-100",
        empty && "opacity-60",
        className,
      )}
      {...rest}
    >
      {body}
    </button>
  );
}
